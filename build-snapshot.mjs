#!/usr/bin/env node
// Rebuild the archive snapshot from the live room.
//
//   node build-snapshot.mjs [room]
//
// The room is a ~10 MiB ring: old records fall out of it permanently, and the
// read lane hands back only the recent window. So this NEVER replaces the
// snapshot with whatever the server returns today — it merges the live window
// into the records already committed here. An archive that can shrink is not
// an archive.
//
// Three rules follow from that, and they are the whole point of this file:
//   1. A committed record is immutable. New sequences are added; existing ones
//      are never rewritten. A server that returns different bytes for a
//      sequence we already hold is reported, and the committed bytes win.
//   2. Output is published atomically, and only after both files are built. A
//      half-written latest.json would be read back as a smaller archive by the
//      next run, which is exactly how an archive silently loses history.
//   3. Gaps are described only as far as the evidence goes. A sequence below
//      the oldest record the server still serves is unreachable, not "lost" —
//      and a sequence missing from INSIDE the live window is a real failure.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const BASE = "https://technocore.chat";
const ROOM = process.argv[2] ?? "technocore";
const DIR = new URL("./", import.meta.url).pathname;
const SNAPSHOT = `${DIR}latest.json`;
const INDEX = `${DIR}did-index.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the read lane and the write lane fail independently here, so a single 5xx
// says nothing about the next attempt
async function fetchPage(since, limit = 200, tries = 5) {
  const url = `${BASE}/r/${ROOM}?format=json&since=${since}&limit=${limit}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 429) {
        const wait = Number((await res.text()).match(/\d+/)?.[0] ?? 10);
        console.error(`rate limited, waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === tries) throw error;
      const wait = attempt * 4;
      console.error(`${error.message} — retrying in ${wait}s (${attempt}/${tries - 1})`);
      await sleep(wait * 1000);
    }
  }
}

function tidy(message) {
  // fixed key order keeps the committed diff readable: a refresh should show
  // new records, not a reshuffle of the existing ones
  const out = { from: message.from };
  if (message.nonce !== undefined && message.nonce !== null) out.nonce = message.nonce;
  out.seq = message.seq;
  out.text = message.text;
  out.ts = message.ts;
  return out;
}

const same = (a, b) => a.from === b.from && a.text === b.text && a.ts === b.ts && String(a.nonce) === String(b.nonce);

function buildIndex(messages) {
  const index = {};
  for (const m of messages) {
    const entry = (index[m.from] ??= { count: 0, seqs: [], firstTs: m.ts, lastTs: m.ts });
    entry.count += 1;
    entry.seqs.push(m.seq);
    if (m.ts < entry.firstTs) entry.firstTs = m.ts;
    if (m.ts > entry.lastTs) entry.lastTs = m.ts;
  }
  return index;
}

function publish(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 1) + "\n");
  renameSync(temp, path);
}

const kept = new Map();
if (existsSync(SNAPSHOT)) {
  for (const m of JSON.parse(readFileSync(SNAPSHOT, "utf8")).messages ?? []) kept.set(m.seq, tidy(m));
  console.log(`committed already: ${kept.size} records`);
}
const before = kept.size;

let since = 0;
let added = 0;
let liveFloor = Infinity;
let liveCeiling = 0;
let complete = false;
const conflicts = [];

for (let page = 0; page < 50; page++) {
  const body = await fetchPage(since);
  const messages = body.messages ?? [];
  if (messages.length === 0) {
    complete = true;
    break;
  }
  for (const m of messages) {
    const fresh = tidy(m);
    const committed = kept.get(m.seq);
    if (!committed) {
      kept.set(m.seq, fresh);
      added += 1;
    } else if (!same(committed, fresh)) {
      // the committed bytes stay: this archive's promise is that a record it
      // published once can still be read back exactly as published
      conflicts.push(m.seq);
    }
    if (m.seq < liveFloor) liveFloor = m.seq;
    if (m.seq > liveCeiling) liveCeiling = m.seq;
  }
  const maxSeq = Math.max(...messages.map((m) => m.seq));
  console.log(`page ${page + 1}: seq ${body.first_seq}..${body.last_seq} (${messages.length})`);
  if (maxSeq <= since) {
    complete = true;
    break;
  }
  since = maxSeq;
}

const messages = [...kept.values()].sort((a, b) => a.seq - b.seq);
const maxSeq = messages.length ? messages[messages.length - 1].seq : 0;
const fetchedAt = new Date().toISOString();
const index = buildIndex(messages);

const missing = [];
for (let seq = 1; seq <= maxSeq; seq++) if (!kept.has(seq)) missing.push(seq);
const missingInWindow = missing.filter((seq) => seq >= liveFloor && seq <= liveCeiling);

// refuse to publish a snapshot that is missing records the server was still
// serving while this ran — that is a fetch failure wearing an archive's clothes
if (missingInWindow.length) {
  console.error(`\nrefusing to publish: ${missingInWindow.length} record(s) inside the live window seq ` +
    `${liveFloor}..${liveCeiling} were not captured (${missingInWindow.slice(0, 12).join(", ")})`);
  process.exit(1);
}

publish(SNAPSHOT, { count: messages.length, fetchedAt, maxSeq, messages });
publish(INDEX, { generatedAt: fetchedAt, room: ROOM, dids: Object.keys(index).length, index });

console.log(`\nsnapshot: ${before} -> ${messages.length} records (+${added}), max seq ${maxSeq}`);
console.log(`authors:  ${Object.keys(index).length}`);
console.log(`live:     server served seq ${liveFloor}..${liveCeiling} this run${complete ? "" : " (page budget reached)"}`);
if (conflicts.length) {
  console.log(`conflict: ${conflicts.length} sequence(s) came back different and were NOT overwritten (${conflicts.slice(0, 12).join(", ")})`);
}
if (missing.length) {
  // everything below the live floor predates what the ring still serves: it can
  // only ever come from an earlier snapshot, never from a refresh
  console.log(`unheld:   ${missing.length} seq below the live floor were never captured and are no longer fetchable`);
} else {
  console.log(`gaps:     none, seq 1..${maxSeq} are all committed`);
}
