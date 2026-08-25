#!/usr/bin/env node
// Turn the recorder's store into the published archive files, and measure the
// flood while doing it.
//
//   node analyze.mjs [--dir data] [--rooms technocore,lobby]
//
// It reads only what record.mjs actually captured. It never fetches, so it can
// never turn a network failure into a smaller archive, and anyone can re-run it
// against the published store and get the same numbers back.
//
// WHAT IT PUBLISHES
//   archive/<room>.jsonl.gz  every held record, one compact JSON object a line
//   coverage.json            which sequences are held, which are lost, and when
//   flood.json               the duplication measurement
//   did-index.json           per-identity lookup, used by the page
//   recent.json              the newest records, for the page's ledger table
//
// latest.json is deliberately NOT rewritten. It holds technocore seq 1-337: the
// only surviving public copy of the room's first records, captured before the
// ring had evicted anything. No future run can extend or improve it, because
// everything between seq 338 and the ring's floor left the service before this
// recorder existed. It stays exactly as committed.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { toRanges, missingRanges, countRanges, measure, buildIndex, METHOD, SHARDS, shardOf, shardName } from "./lib.mjs";

function flag(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const HERE = new URL("./", import.meta.url).pathname;
const DIR = HERE + flag("--dir", "data") + "/";
const ROOMS = flag("--rooms", "technocore,lobby").split(",").map((r) => r.trim()).filter(Boolean);

export function loadRecords(path) {
  if (!existsSync(path)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      // the store is append-only and a crash can replay a batch, so the first
      // copy of a sequence wins here exactly as it does in the recorder
      if (seen.has(record.seq)) continue;
      seen.add(record.seq);
      out.push(record);
    } catch {
      // a torn last line from a killed recorder is not history
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function publish(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, typeof value === "string" ? value : JSON.stringify(value));
  renameSync(temp, path);
}

const byRoom = {};
const coverage = { generatedAt: new Date().toISOString(), rooms: {} };

for (const room of ROOMS) {
  const records = loadRecords(`${DIR}${room}.jsonl`);
  if (!records.length) {
    console.log(`${room}: nothing captured, skipping`);
    continue;
  }
  byRoom[room] = records;

  const state = existsSync(`${DIR}${room}.state.json`)
    ? JSON.parse(readFileSync(`${DIR}${room}.state.json`, "utf8"))
    : {};
  const held = toRanges(records.map((r) => r.seq));
  const notes = state.lost ?? [];

  // The highest sequence we have any evidence of: usually the newest record we
  // hold, but a note can prove the room went further than we ever reached.
  const maxSeq = Math.max(
    records[records.length - 1].seq,
    state.maxSeq ?? 0,
    notes.reduce((n, g) => Math.max(n, g.to), 0),
  );

  // Loss is the complement of what we hold, never the sum of the recorder's
  // notes. The same interval can be noticed more than once — an empty response
  // keeps reporting a head the cursor cannot reach — and adding those up would
  // claim the ring destroyed more than it did. The notes stay the only source
  // of *why* a range is missing, which the complement cannot know.
  const lostRanges = missingRanges(held, maxSeq);
  const reasons = new Set();
  for (const note of notes) {
    if (lostRanges.some(([from, to]) => note.from <= to && note.to >= from)) reasons.add(note.reason);
  }

  coverage.rooms[room] = {
    records: records.length,
    heldRanges: held,
    heldRecords: countRanges(held),
    lostRanges,
    lostRecords: countRanges(lostRanges),
    lostReasons: [...reasons],
    maxSeq,
    firstCaptureAt: state.firstCaptureAt ?? null,
    lastCaptureAt: state.lastCaptureAt ?? null,
    firstTs: records[0].ts,
    lastTs: records[records.length - 1].ts,
    conflicts: (state.conflicts ?? []).length,
  };

  mkdirSync(`${HERE}archive`, { recursive: true });
  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(`${HERE}archive/${room}.jsonl.gz`, gzipSync(Buffer.from(jsonl), { level: 9 }));
  console.log(
    `${room}: ${records.length} records, seq ${records[0].seq}..${records[records.length - 1].seq}, ` +
    `${lostRanges.length} lost range(s) totalling ${coverage.rooms[room].lostRecords}`,
  );
}

const flood = { generatedAt: coverage.generatedAt, method: METHOD, rooms: {} };

for (const [room, records] of Object.entries(byRoom)) {
  // Measure the continuously captured block only — the last contiguous held
  // range. For technocore that excludes the 337 genesis records: they are a
  // different era of the room, two days and 54,000 sequences earlier, and
  // averaging them in would flatter the duplication numbers with traffic that
  // predates the flood entirely.
  const state = coverage.rooms[room];
  const [windowStart] = state.heldRanges[state.heldRanges.length - 1] ?? [0];
  const windowRecords = records.filter((r) => r.seq >= windowStart);
  const first = windowRecords[0];
  const last = windowRecords[windowRecords.length - 1];

  flood.rooms[room] = {
    window: {
      fromSeq: first?.seq ?? null,
      toSeq: last?.seq ?? null,
      fromTs: first?.ts ?? null,
      toTs: last?.ts ?? null,
      minutes: windowRecords.length > 1
        ? Math.round(((new Date(last.ts) - new Date(first.ts)) / 60000) * 10) / 10
        : 0,
    },
    ...measure(windowRecords),
  };

  const m = flood.rooms[room];
  m.window.recordsPerMinute = m.window.minutes ? Math.round(m.records / m.window.minutes) : null;
  console.log(
    `${room}: ${m.records} records over ${m.window.minutes}m, ${m.identities} identities, ` +
    `${m.exact.duplicateShare}% exact dupes, ${m.template.sharedShare}% shared-template, ` +
    `${m.posters.withOriginalText}/${m.posters.total} posted original text`,
  );
}

const index = buildIndex(byRoom);
const recent = Object.entries(byRoom)
  .flatMap(([room, records]) =>
    records.slice(-250).map((r) => ({ room, seq: r.seq, from: r.from, text: r.text, ts: r.ts, signed: r.nonce != null })))
  .sort((a, b) => (a.ts < b.ts ? 1 : -1))
  .slice(0, 300);

publish(`${HERE}coverage.json`, coverage);
publish(`${HERE}flood.json`, flood);

// did-index.json is the manifest only; the entries live in dids/NN.json so a
// lookup costs one small file instead of the whole flood.
mkdirSync(`${HERE}dids`, { recursive: true });
const shards = Array.from({ length: SHARDS }, () => ({}));
for (const [did, entry] of Object.entries(index)) shards[shardOf(did)][did] = entry;
shards.forEach((bucket, n) => publish(`${HERE}${shardName(n)}`, bucket));

publish(`${HERE}did-index.json`, {
  generatedAt: coverage.generatedAt,
  rooms: Object.keys(byRoom),
  dids: Object.keys(index).length,
  shards: SHARDS,
  shardPath: "dids/NN.json, NN = FNV-1a(did) mod shards, zero padded",
  note: "seqs are capped at 12 per identity; count is the true total",
});
publish(`${HERE}recent.json`, { generatedAt: coverage.generatedAt, records: recent });

console.log(`\nindex:    ${Object.keys(index).length} identities`);
console.log("published coverage.json, flood.json, did-index.json, recent.json, archive/*.jsonl.gz");
console.log("latest.json untouched: technocore seq 1-337 is the earliest surviving public copy and cannot be extended");
