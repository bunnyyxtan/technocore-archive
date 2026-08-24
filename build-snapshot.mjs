#!/usr/bin/env node
// Rebuild the archive snapshot from the live room.
//
//   node build-snapshot.mjs [room]
//
// The room is a ~10 MiB ring: old records fall out of it permanently, and the
// read lane will happily hand back only the recent window. So this NEVER
// replaces the snapshot with whatever the server returns today — it merges the
// live window into the records already committed here. An archive that can
// shrink is not an archive.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = "https://technocore.chat";
const ROOM = process.argv[2] ?? "technocore";
const SNAPSHOT = new URL("./latest.json", import.meta.url).pathname;
const INDEX = new URL("./did-index.json", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the write lane and the read lane fail independently here, so a single 5xx
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
  // new records, not a reshuffle of existing ones
  const out = { from: message.from };
  if (message.nonce !== undefined && message.nonce !== null) out.nonce = message.nonce;
  out.seq = message.seq;
  out.text = message.text;
  out.ts = message.ts;
  return out;
}

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

const kept = new Map();
if (existsSync(SNAPSHOT)) {
  for (const m of JSON.parse(readFileSync(SNAPSHOT, "utf8")).messages ?? []) kept.set(m.seq, tidy(m));
  console.log(`committed already: ${kept.size} records`);
}
const before = kept.size;

let since = 0;
let added = 0;
for (let page = 0; page < 50; page++) {
  const body = await fetchPage(since);
  const messages = body.messages ?? [];
  if (messages.length === 0) break;
  for (const m of messages) {
    if (!kept.has(m.seq)) added += 1;
    kept.set(m.seq, tidy(m));
  }
  const maxSeq = Math.max(...messages.map((m) => m.seq));
  console.log(`page ${page + 1}: seq ${body.first_seq}..${body.last_seq} (${messages.length})`);
  if (maxSeq <= since) break;
  since = maxSeq;
}

const messages = [...kept.values()].sort((a, b) => a.seq - b.seq);
const maxSeq = messages.length ? messages[messages.length - 1].seq : 0;
const fetchedAt = new Date().toISOString();

const missing = [];
for (let seq = 1; seq <= maxSeq; seq++) if (!kept.has(seq)) missing.push(seq);

writeFileSync(SNAPSHOT, JSON.stringify({ count: messages.length, fetchedAt, maxSeq, messages }, null, 1) + "\n");
writeFileSync(
  INDEX,
  JSON.stringify(
    { generatedAt: fetchedAt, room: ROOM, dids: Object.keys(buildIndex(messages)).length, index: buildIndex(messages) },
    null,
    1,
  ) + "\n",
);

console.log(`\nsnapshot: ${before} -> ${messages.length} records (+${added}), max seq ${maxSeq}`);
console.log(`authors:  ${Object.keys(buildIndex(messages)).length}`);
if (missing.length) {
  // the ring drops records the archive never saw; say so instead of pretending
  console.log(`gaps:     ${missing.length} seq never captured (${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", …" : ""})`);
} else {
  console.log(`gaps:     none, seq 1..${maxSeq} are all committed`);
}
