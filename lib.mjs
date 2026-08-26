// Pure logic shared by the recorder and the publisher.
//
// Nothing in here touches the network, the clock or the filesystem, so every
// number the archive publishes can be re-derived from the published records by
// anyone, and every rule can be tested without a live room. That is the whole
// reason this file exists separately from record.mjs and analyze.mjs.

// ------------------------------------------------------------- record shape

// fixed key order so the store diffs cleanly and hashes stably
export function tidy(message) {
  const out = { from: message.from };
  if (message.nonce !== undefined && message.nonce !== null) out.nonce = message.nonce;
  out.seq = message.seq;
  out.text = message.text;
  out.ts = message.ts;
  return out;
}

export const same = (a, b) =>
  a.from === b.from && a.text === b.text && a.ts === b.ts && String(a.nonce) === String(b.nonce);

// ------------------------------------------------------------------ coverage

// contiguous [from,to] runs over a sequence list — how coverage is stated
export function toRanges(seqs) {
  const sorted = [...seqs].sort((a, b) => a - b);
  const ranges = [];
  for (const seq of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && seq === last[1] + 1) last[1] = seq;
    else if (!last || seq !== last[1]) ranges.push([seq, seq]);
  }
  return ranges;
}

// the complement of held inside [1,maxSeq] — everything the ring took from us
export function missingRanges(held, maxSeq) {
  const gaps = [];
  let expect = 1;
  for (const [from, to] of held) {
    if (from > expect) gaps.push([expect, from - 1]);
    expect = to + 1;
  }
  if (expect <= maxSeq) gaps.push([expect, maxSeq]);
  return gaps;
}

export const countRanges = (ranges) => ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);

// ------------------------------------------------------------ capture liveness
//
// A dead recorder used to be invisible. The archive kept serving its last known
// state, the page kept saying "recording", and the only evidence that capture
// had stopped was a human reading the workflow log. Because the rooms are ring
// buffers, every minute of that silence is permanent loss, so the archive has
// to be able to say "I am not recording" on its own.
//
// The hard part is the threshold. Ten seconds of silence is a catastrophe in
// lobby, which replaces its entire 200-record read window in about nine
// seconds, and completely unremarkable in a room that posts twice an hour. A
// number typed in here would be wrong for one of them, and would go on being
// wrong as the rooms change hour to hour. So the threshold comes from the
// intervals capture has actually been running at — the room's own heartbeat,
// measured, not assumed.

// How many recent intervals decide the cadence. Bounded, so the verdict follows
// the room as it speeds up and slows down, and so no pass here grows with the
// archive.
export const CADENCE_SAMPLES = 120;

// The one number here that does not come from the room: a floor under the stall
// threshold. It is a promise about how quickly this archive is willing to cry
// wolf — a single slow response in a room capturing three times a second must
// not raise an alarm — and never an assumption about how fast a room runs. It
// only ever makes the detector wait longer, never fire sooner.
export const MIN_STALL_SECONDS = 30;

// Stalled means capture has missed its beat by a wide margin. Stopped means it
// is not coming back on its own. Keeping them apart is what separates a hiccup
// worth watching from an outage worth acting on.
export const STOP_MULTIPLE = 4;

const round = (value) => Math.round(value * 10) / 10;

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

// intervals: seconds between consecutive captures, oldest first.
export function captureCadence(intervals) {
  const usable = [];
  for (const value of intervals ?? []) {
    if (Number.isFinite(value) && value >= 0) usable.push(value);
  }
  const recent = usable.slice(-CADENCE_SAMPLES);
  const sorted = recent.slice().sort((a, b) => a - b);
  return {
    samples: recent.length,
    // Median, not mean. An interruption sits in this list as one enormous
    // interval, and a mean would let the outage raise the threshold until the
    // next one could never be noticed. The median shrugs it off.
    heartbeatSeconds: round(quantile(sorted, 0.5)),
    // The slowest beat that is still normal for this room, so ordinary jitter
    // is never reported as a stall.
    jitterSeconds: round(quantile(sorted, 0.95)),
  };
}

// Turn a measured cadence into the two ages at which silence stops being normal.
export function captureThresholds(cadence) {
  const samples = cadence?.samples ?? 0;
  const heartbeat = samples >= 2 ? cadence.heartbeatSeconds : 0;
  const jitter = samples >= 2 ? cadence.jitterSeconds : 0;
  // Six normal beats, or three of the room's slowest ordinary beats, whichever
  // is longer: a steady room is judged on its heartbeat, a bursty one on its
  // jitter, and neither is judged on a guess.
  const observed = Math.max(heartbeat * 6, jitter * 3);
  const stallAfterSeconds = round(Math.max(observed, MIN_STALL_SECONDS));
  return {
    stallAfterSeconds,
    stopAfterSeconds: round(stallAfterSeconds * STOP_MULTIPLE),
    // false means the room has not shown enough of itself yet and the floor is
    // doing the work. Published, so nobody has to guess which one answered.
    derivedFromRoom: observed > MIN_STALL_SECONDS,
  };
}

// The verdict, from the age of the newest captured record. "starting" is only
// ever the answer before the first record of all: once a room has captured
// once, silence is measured, never excused.
export function captureState(ageSeconds, cadence) {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return "starting";
  const { stallAfterSeconds, stopAfterSeconds } = captureThresholds(cadence);
  if (ageSeconds >= stopAfterSeconds) return "stopped";
  if (ageSeconds >= stallAfterSeconds) return "stalled";
  return "recording";
}

export const ageInSeconds = (fromIso, atIso) => {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const at = atIso ? Date.parse(atIso) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(at)) return null;
  return Math.max(0, (at - from) / 1000);
};

// ------------------------------------------------------------- the interruption ledger
//
// An interruption is a hole in coverage exactly like an evicted range is, and
// it belongs in the same accounting. Held sequences alone cannot express it:
// while capture is down the room's head keeps moving and this archive has no
// way to know how far, so the honest record is the interval itself, plus
// whichever sequences the ring turned out to have destroyed by the time we came
// back. An open entry — to: null — says capture is down right now.

// the newest entry, if it is still open
export function openOutage(outages) {
  const last = (outages ?? [])[(outages ?? []).length - 1];
  return last && !last.to ? last : null;
}

export function outageSeconds(outage, atIso) {
  if (!outage) return 0;
  return ageInSeconds(outage.from, outage.to ?? atIso) ?? 0;
}

export function outageSummary(outages, atIso) {
  const list = outages ?? [];
  let unrecordedSeconds = 0;
  let longestSeconds = 0;
  for (const outage of list) {
    const seconds = outageSeconds(outage, atIso);
    unrecordedSeconds += seconds;
    if (seconds > longestSeconds) longestSeconds = seconds;
  }
  const open = openOutage(list);
  return {
    interruptions: list.length,
    interrupted: Boolean(open),
    since: open ? open.from : null,
    reason: open ? open.reason : null,
    unrecordedSeconds: round(unrecordedSeconds),
    longestSeconds: round(longestSeconds),
  };
}

// ------------------------------------------------------------- normalisation

// Two ways of asking "is this the same post again", reported side by side.
//
// exact is the conservative one: collapse whitespace, nothing else. If two
// records share an exact key, a human reading them would call them identical.
//
// template is the interesting one. The cheapest way to look like a hundred
// participants is to post one sentence from a hundred keys, and the giveaway is
// that the only thing that changes between them is the author's own identifiers.
// So the author's identifiers are exactly what gets replaced before comparing.

export function exactKey(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

const DID_TOKEN = /did:key:z[1-9A-HJ-NP-Za-km-z]{20,}/g;
const URL_TOKEN = /\bhttps?:\/\/\S+/gi;
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|xyz|chat|co|dev|app|gg|me|finance|fun)(?:\/\S*)?/gi;
const BLOB_TOKEN = /\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g;

export function templateKey(text) {
  return String(text ?? "")
    .normalize("NFKC")
    // order matters: a did:key contains a base58 blob and a URL can contain
    // both, so the most specific pattern has to claim its text first
    .replace(DID_TOKEN, " <did> ")
    .replace(URL_TOKEN, " <url> ")
    .replace(BARE_HOST, " <url> ")
    .replace(BLOB_TOKEN, " <blob> ")
    .toLowerCase()
    .replace(/\d+/g, " <n> ")
    .replace(/[^\p{L}\p{N}<>]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const METHOD = {
  exact: "whitespace collapsed and trimmed, nothing else",
  template:
    "NFKC; did:key -> <did>; URL -> <url>; base58/hex blob of 32+ chars -> <blob>; digits -> <n>; " +
    "lowercased; punctuation and emoji dropped",
  sharedGroup: "a template group holding records from two or more distinct identities",
  scope: "the continuously captured window only, never the genesis block",
  reproduce: "node analyze.mjs, over the published archive/<room>.jsonl.gz",
  // the read lane returns from, nonce, seq, text and ts — no signature. so a
  // nonce is the only evidence a record went through the signed write path, and
  // nobody, including this archive, can re-verify these signatures afterwards.
  signature: "a nonce, which the signed-write path attaches; the read API never returns the signature itself, " +
    "so no record in this archive can be cryptographically re-verified from the public feed",
};

// ----------------------------------------------------------------- measuring

export function group(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record.text);
    if (!key) continue;
    let entry = groups.get(key);
    if (!entry) {
      groups.set(key, (entry = {
        key,
        count: 0,
        identities: new Set(),
        first: record,
        firstTs: record.ts,
        lastTs: record.ts,
      }));
    }
    entry.count += 1;
    entry.identities.add(record.from);
    if (record.ts < entry.firstTs) entry.firstTs = record.ts;
    if (record.ts > entry.lastTs) entry.lastTs = record.ts;
  }
  return groups;
}

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export function measure(records) {
  const total = records.length;
  const identities = new Set(records.map((r) => r.from));

  const exact = group(records, exactKey);
  const template = group(records, templateKey);

  let exactDuplicated = 0;
  for (const entry of exact.values()) if (entry.count > 1) exactDuplicated += entry.count;

  let templateDuplicated = 0;
  let sharedRecords = 0;
  let sharedGroups = 0;
  for (const entry of template.values()) {
    if (entry.count > 1) templateDuplicated += entry.count;
    if (entry.identities.size > 1) {
      sharedGroups += 1;
      sharedRecords += entry.count;
    }
  }

  // classify each identity by what it actually posted. one identity repeating
  // itself is noisy; one sentence arriving from many keys is the thing worth
  // separating out, so the two are never added together.
  const perIdentity = new Map();
  for (const record of records) {
    const entry = template.get(templateKey(record.text));
    let who = perIdentity.get(record.from);
    if (!who) perIdentity.set(record.from, (who = { records: 0, original: 0, shared: 0, selfRepeat: 0 }));
    who.records += 1;
    if (!entry || entry.count === 1) who.original += 1;
    else if (entry.identities.size > 1) who.shared += 1;
    else who.selfRepeat += 1;
  }

  let sharedTemplateOnly = 0;
  let withOriginalText = 0;
  let selfRepeatOnly = 0;
  for (const who of perIdentity.values()) {
    if (who.original > 0) withOriginalText += 1;
    else if (who.shared > 0) sharedTemplateOnly += 1;
    else selfRepeatOnly += 1;
  }

  const topTemplates = [...template.values()]
    .filter((entry) => entry.identities.size > 1)
    .sort((a, b) => b.count - a.count || b.identities.size - a.identities.size)
    .slice(0, 15)
    .map((entry) => ({
      records: entry.count,
      identities: entry.identities.size,
      shareOfWindow: pct(entry.count, total),
      firstTs: entry.firstTs,
      lastTs: entry.lastTs,
      sample: entry.first.text.length > 300 ? entry.first.text.slice(0, 300) + "…" : entry.first.text,
    }));

  // per-minute shape of the window, so a spike is visible as a spike
  const buckets = new Map();
  for (const record of records) {
    const minute = String(record.ts ?? "").slice(0, 16);
    if (!minute) continue;
    let bucket = buckets.get(minute);
    if (!bucket) buckets.set(minute, (bucket = { minute, records: 0, sharedTemplate: 0, identities: new Set() }));
    bucket.records += 1;
    bucket.identities.add(record.from);
    const entry = template.get(templateKey(record.text));
    if (entry && entry.identities.size > 1) bucket.sharedTemplate += 1;
  }
  const timeline = [...buckets.values()]
    .sort((a, b) => a.minute.localeCompare(b.minute))
    .map((b) => ({
      minute: b.minute + "Z",
      records: b.records,
      sharedTemplate: b.sharedTemplate,
      sharedShare: pct(b.sharedTemplate, b.records),
      identities: b.identities.size,
    }));

  const signed = records.filter((r) => r.nonce !== undefined && r.nonce !== null).length;

  return {
    records: total,
    identities: identities.size,
    signedRecords: signed,
    signedShare: pct(signed, total),
    exact: {
      uniqueTexts: exact.size,
      duplicatedRecords: exactDuplicated,
      duplicateShare: pct(exactDuplicated, total),
    },
    template: {
      uniqueTemplates: template.size,
      duplicatedRecords: templateDuplicated,
      duplicateShare: pct(templateDuplicated, total),
      sharedGroups,
      sharedRecords,
      sharedShare: pct(sharedRecords, total),
    },
    posters: {
      total: perIdentity.size,
      withOriginalText,
      sharedTemplateOnly,
      selfRepeatOnly,
      originalShare: pct(withOriginalText, perIdentity.size),
    },
    topTemplates,
    timeline,
  };
}

// -------------------------------------------------------------- the lookup

export const MAX_SEQS = 12;
export const MAX_SAMPLES = 3;
export const SAMPLE_CHARS = 140;

// The flood mints a fresh identity per post, so the index grows without bound
// while the page only ever needs one entry from it. Shard it and let the page
// fetch a single bucket.
//
// FNV-1a, because app.js has to compute the identical bucket in the browser and
// this is short enough to keep byte-identical in both places. The pinned test
// vectors in test.mjs exist so that changing one copy fails loudly instead of
// silently sending every lookup to the wrong file.
export const SHARDS = 64;

export function shardOf(did, shards = SHARDS) {
  let hash = 2166136261;
  for (let i = 0; i < did.length; i++) {
    hash ^= did.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash % shards;
}

export const shardName = (n) => "dids/" + String(n).padStart(2, "0") + ".json";

export function buildIndex(byRoom) {
  const index = {};
  for (const [room, records] of Object.entries(byRoom)) {
    const template = group(records, templateKey);
    for (const record of records) {
      const entry = (index[record.from] ??= {
        count: 0,
        rooms: {},
        seqs: [],
        firstTs: record.ts,
        lastTs: record.ts,
        samples: [],
        signed: false,
        shared: 0,
      });
      entry.count += 1;
      entry.rooms[room] = (entry.rooms[room] ?? 0) + 1;
      if (entry.seqs.length < MAX_SEQS) entry.seqs.push(record.seq);
      if (record.ts < entry.firstTs) entry.firstTs = record.ts;
      if (record.ts > entry.lastTs) entry.lastTs = record.ts;
      if (record.nonce !== undefined && record.nonce !== null) entry.signed = true;
      const shared = template.get(templateKey(record.text));
      if (shared && shared.identities.size > 1) entry.shared += 1;
      if (entry.samples.length < MAX_SAMPLES && record.text) {
        entry.samples.push({
          room,
          seq: record.seq,
          text: record.text.length > SAMPLE_CHARS ? record.text.slice(0, SAMPLE_CHARS) + "…" : record.text,
        });
      }
    }
  }
  return index;
}
