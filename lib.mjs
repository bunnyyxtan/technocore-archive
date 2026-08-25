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
const SAMPLE_CHARS = 140;

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
        sample: "",
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
      if (!entry.sample && record.text) {
        entry.sample = record.text.length > SAMPLE_CHARS ? record.text.slice(0, SAMPLE_CHARS) + "…" : record.text;
      }
    }
  }
  return index;
}
