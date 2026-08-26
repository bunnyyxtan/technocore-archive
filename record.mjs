#!/usr/bin/env node
// Follow technocore.chat rooms continuously and keep every record served.
//
//   node record.mjs --rooms technocore,lobby [--minutes 45] [--dir data]
//
// WHY THIS EXISTS, AND WHY IT IS NOT build-snapshot.mjs
//
// build-snapshot.mjs was written when the room held 337 records and nothing had
// ever been evicted: one pass over the window captured the whole room. That is
// no longer true and cannot be made true again. Measured 2026-08-25, the read
// window is 200 records and the rooms run at:
//
//     technocore   ~460 records/min   window turns over every ~26s
//     lobby       ~1290 records/min   window turns over every ~9s
//
// So a one-shot builder run every few minutes is not a slow archive, it is a
// sampler that silently drops the majority of the room. To hold a room whose
// entire visible history is replaced three times a minute, the reader has to
// stay ahead of eviction continuously. Hence a resumable follower.
//
// The rules it inherits from the builder, unchanged:
//   1. A captured record is immutable. Sequences are added, never rewritten. A
//      server that returns different bytes for a sequence already held gets
//      logged as a conflict and loses.
//   2. A fetch failure is never published as an archive. This process only ever
//      appends what the server actually returned; it never writes a "no records"
//      result, and the builder that publishes reads only from this store.
//   3. Gaps are recorded, never papered over. If eviction outran us the missing
//      range is written down as lost, with the reason and the moment we noticed.
//      An archive that hides its holes is worse than one that admits them.
//      A stall is one of those holes: when capture falls behind its own measured
//      cadence the interruption is opened in the state file straight away, and
//      whatever the ring destroyed meanwhile is attached to it on resume.
//
// Store layout, per room:
//   <dir>/<room>.jsonl        append-only, one compact record per line
//   <dir>/<room>.state.json   cursor, held ranges, lost ranges, capture times
//
// Append-only matters: the process is killed with a signal, and a partial line
// is recoverable (the loader drops a trailing unparseable line) whereas a
// partially rewritten 30 MB JSON document is not.

import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  tidy,
  same,
  toRanges,
  CADENCE_SAMPLES,
  ageInSeconds,
  captureCadence,
  captureState,
  captureThresholds,
  openOutage,
  outageSeconds,
  outageSummary,
} from "./lib.mjs";

const BASE = "https://technocore.chat";
const LIMIT = 200; // the server's maximum, and the whole point: fewer means falling behind

// Aim each batch at this many records rather than at a fixed clock interval.
// The room's rate is the only thing that decides whether we lose history, and
// it differs by an order of magnitude between rooms (measured 2026-08-25:
// technocore ~7.7/s, lobby ~21.5/s) and changes hour to hour. Targeting a fill
// well under LIMIT leaves better than 3x headroom for a burst before a single
// batch could overflow the window, and costs ~30 reads/min against a published
// budget of 600 — so the safety margin is free.
const TARGET_BATCH = 60;
const MIN_WAIT = 500;
const MAX_WAIT = 4000;

function flag(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const ROOMS = flag("--rooms", "technocore,lobby").split(",").map((r) => r.trim()).filter(Boolean);
const MINUTES = Number(flag("--minutes", "0"));
const DIR = new URL("./", import.meta.url).pathname + flag("--dir", "data") + "/";
const SEED = new URL("./latest.json", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- record shape

const line = (m) => JSON.stringify(tidy(m));

// ------------------------------------------------------------------ read lane

// the read and write lanes fail independently here, and 5xx is routine, so a
// single failure says nothing about the next attempt. what a failure must never
// do is look like "the room is empty".
async function readRoom(room, since, tries = 6) {
  const url = `${BASE}/r/${room}?format=json&since=${since}&limit=${LIMIT}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) {
        const wait = Number((await res.text()).match(/\d+/)?.[0] ?? 5);
        await sleep(Math.min(wait, 30) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === tries) throw error;
      await sleep(Math.min(attempt * 750, 4000));
    }
  }
}

// ---------------------------------------------------------------- room follower

export class RoomStore {
  // dir and seed are arguments rather than module constants so the load and
  // resume path can be exercised against a throwaway store on disk. The
  // recorder itself always passes the run's own directory.
  constructor(room, dir = DIR, seed = SEED) {
    this.room = room;
    this.dir = dir.endsWith("/") ? dir : `${dir}/`;
    this.seed = seed;
    this.path = `${this.dir}${room}.jsonl`;
    this.statePath = `${this.dir}${room}.state.json`;
    this.held = new Set();
    this.conflicts = [];
    this.lost = [];
    this.cursor = 0;
    this.firstCaptureAt = null;
    this.lastCaptureAt = null;
    this.lastReadAt = null; // last read the server actually answered, records or not
    this.polls = 0;
    this.captured = 0;
    this.behind = 0; // batches that came back full: proof we were not keeping up
    this.rate = 0; // records/second, smoothed — drives the poll pacing
    this.ratedAt = 0;
    this.records = new Map(); // seq -> record, for conflict detection
    // seconds between consecutive captures — the room's own heartbeat, and the
    // only thing allowed to decide how long silence may last before it counts
    // as a stall. An interval measured across a known interruption is never
    // added: that is the outage's length, not the room's cadence.
    this.captureIntervals = [];
    this.outages = []; // interruption ledger, alongside this.lost
    this.captureState = "starting";
  }

  load() {
    mkdirSync(this.dir, { recursive: true });

    // seed the technocore store from the committed genesis snapshot, so the
    // store is the single complete source and 1..337 are known-held rather than
    // known-lost. the seed is only ever used to create the store, never to
    // overwrite records already captured.
    if (!existsSync(this.path) && this.room === "technocore" && this.seed && existsSync(this.seed)) {
      const seeded = JSON.parse(readFileSync(this.seed, "utf8")).messages ?? [];
      if (seeded.length) {
        appendFileSync(this.path, seeded.map(line).join("\n") + "\n");
        console.log(`${this.room}: seeded ${seeded.length} genesis records from latest.json`);
      }
    }

    if (existsSync(this.path)) {
      const text = readFileSync(this.path, "utf8");
      const lines = text.split("\n");
      let dropped = 0;
      for (const raw of lines) {
        if (!raw) continue;
        try {
          const m = JSON.parse(raw);
          this.held.add(m.seq);
          this.records.set(m.seq, m);
        } catch {
          dropped += 1; // a torn final line from a killed process, not history
        }
      }
      if (dropped) console.log(`${this.room}: dropped ${dropped} unparseable line(s) from a previous run`);
    }

    if (existsSync(this.statePath)) {
      const state = JSON.parse(readFileSync(this.statePath, "utf8"));
      this.lost = state.lost ?? [];
      this.conflicts = state.conflicts ?? [];
      this.firstCaptureAt = state.firstCaptureAt ?? null;
      // Restored, not reset. The moment of the last capture before this process
      // existed is the only evidence of how long the archive was unattended, and
      // the cadence measured before the restart is the only thing that can say
      // whether that silence was normal for this room.
      this.lastCaptureAt = state.lastCaptureAt ?? null;
      this.lastReadAt = state.lastReadAt ?? null;
      this.captureIntervals = state.captureIntervals ?? [];
      this.outages = state.outages ?? [];
    }

    // resume from the highest sequence actually on disk, never from the saved
    // cursor: if the process died between appending and flushing state, the
    // records won and the cursor must agree with them
    // Math.max(...set) spreads one argument per record and blows the call
    // stack once a room holds tens of thousands of them, so fold instead
    let highest = 0;
    for (const seq of this.held) if (seq > highest) highest = seq;
    this.cursor = highest;
    console.log(`${this.room}: resuming at seq ${this.cursor} with ${this.held.size} records held`);
  }

  // a gap between our cursor and the oldest record the server still serves is
  // not a bug to retry — those records are already out of the ring. write it
  // down with the reason and move on.
  noteLoss(from, to, reason) {
    if (to < from) return;
    const last = this.lost[this.lost.length - 1];
    // The same interval gets noticed repeatedly: while the cursor is stuck
    // behind the ring, every empty response reports the same unreachable head.
    // Overlapping notes merge rather than stack, so the list stays a set of
    // intervals instead of a running tally that would exaggerate the loss.
    if (last && last.reason === reason && from <= last.to + 1) last.to = Math.max(last.to, to);
    else this.lost.push({ from, to, reason, noticedAt: now() });

    // If capture is interrupted right now, this is the ring destroying records
    // while nobody was there to take them. Name the same hole on the
    // interruption, so the two ledgers cannot tell different stories about it.
    const open = openOutage(this.outages);
    if (open) {
      open.lostFrom = open.lostFrom == null ? from : Math.min(open.lostFrom, from);
      open.lostTo = open.lostTo == null ? to : Math.max(open.lostTo, to);
    }
  }

  // The measured heartbeat, and the ages at which silence stops being normal.
  cadence() {
    return captureCadence(this.captureIntervals);
  }

  liveness(atIso = now()) {
    const cadence = this.cadence();
    const age = ageInSeconds(this.lastCaptureAt, atIso);
    return {
      at: atIso,
      captureAgeSeconds: age,
      readAgeSeconds: ageInSeconds(this.lastReadAt, atIso),
      state: captureState(age, cadence),
      cadence,
      ...captureThresholds(cadence),
      ...outageSummary(this.outages, atIso),
    };
  }

  // Judge capture against its own cadence and write the verdict down. Called on
  // the flush tick and once at startup: a recorder that died and came back has
  // to admit the silence it slept through, not quietly resume as if the archive
  // had been complete the whole time.
  watch(atIso = now(), startupReason = null) {
    const view = this.liveness(atIso);
    const changed = view.state !== this.captureState;
    this.captureState = view.state;
    if (view.state === "recording" || view.state === "starting") return view;

    const open = openOutage(this.outages);
    if (!open) {
      // Reads and captures fail apart. A room we cannot read is our outage; a
      // room that answers and has nothing new is the room's own quiet, and
      // saying so is the difference between an honest ledger and a scare.
      const unreachable =
        view.readAgeSeconds == null || view.readAgeSeconds >= view.stallAfterSeconds;
      const reason = startupReason
        ?? (unreachable ? "the room could not be read" : "the room served no new records");
      this.outages.push({
        from: this.lastCaptureAt,
        to: null,
        reason,
        noticedAt: atIso,
        lostFrom: null,
        lostTo: null,
      });
      console.error(
        `${this.room}: capture ${view.state} — ${reason}; last record ${Math.round(view.captureAgeSeconds)}s ago, ` +
        `expected within ${view.stallAfterSeconds}s`,
      );
    } else if (changed) {
      console.error(`${this.room}: capture ${view.state} — ${Math.round(view.captureAgeSeconds)}s since the last record`);
    }
    // re-read, so the returned view accounts for the entry just opened rather
    // than the ledger as it stood a moment before the stall was noticed
    return this.liveness(atIso);
  }

  absorb(messages) {
    const fresh = [];
    for (const m of messages) {
      const committed = this.records.get(m.seq);
      const record = tidy(m);
      if (!committed) {
        this.held.add(m.seq);
        this.records.set(m.seq, record);
        fresh.push(record);
      } else if (!same(committed, record) && this.conflicts.length < 200) {
        // captured bytes stay: a record published once must read back as published
        this.conflicts.push({ seq: m.seq, noticedAt: now() });
      }
    }
    if (fresh.length) {
      // one append per batch, so a kill can only ever tear the last line
      appendFileSync(this.path, fresh.map((m) => JSON.stringify(m)).join("\n") + "\n");
      this.captured += fresh.length;
      this.noteCapture(now());
    }
    return fresh.length;
  }

  // Every capture is one beat of the room's heartbeat, and the end of any
  // interruption that was still open.
  noteCapture(atIso) {
    const open = openOutage(this.outages);
    if (open) {
      open.to = atIso;
      const lost = open.lostFrom == null
        ? "no sequence proved lost"
        : `seq ${open.lostFrom}..${open.lostTo} gone from the ring`;
      console.log(
        `${this.room}: capture resumed after ${Math.round(outageSeconds(open, atIso))}s (${open.reason}) — ${lost}`,
      );
    } else if (this.lastCaptureAt) {
      // Only intervals from uninterrupted running describe the room. Measuring
      // one across an outage would teach the detector that the outage was normal
      // and blind it to the next one.
      const gap = ageInSeconds(this.lastCaptureAt, atIso);
      if (gap != null) {
        this.captureIntervals.push(gap);
        if (this.captureIntervals.length > CADENCE_SAMPLES * 2) {
          this.captureIntervals = this.captureIntervals.slice(-CADENCE_SAMPLES);
        }
      }
    }
    this.lastCaptureAt = atIso;
    this.firstCaptureAt ??= atIso;
    this.captureState = "recording";
  }

  flush() {
    const held = toRanges(this.held);
    const maxSeq = this.cursor;
    const at = now();
    const view = this.liveness(at);
    const state = {
      room: this.room,
      cursor: this.cursor,
      records: this.held.size,
      maxSeq,
      heldRanges: held,
      lost: this.lost,
      lostRecords: this.lost.reduce((n, g) => n + (g.to - g.from + 1), 0),
      firstCaptureAt: this.firstCaptureAt,
      lastCaptureAt: this.lastCaptureAt,
      lastReadAt: this.lastReadAt,
      // The verdict and the measurements behind it, so a reader of the store
      // can re-derive it rather than take it on trust.
      captureState: view.state,
      heartbeatSeconds: view.cadence.heartbeatSeconds,
      jitterSeconds: view.cadence.jitterSeconds,
      cadenceSamples: view.cadence.samples,
      stallAfterSeconds: view.stallAfterSeconds,
      stopAfterSeconds: view.stopAfterSeconds,
      stallThresholdDerived: view.derivedFromRoom,
      outages: this.outages,
      unrecordedSeconds: view.unrecordedSeconds,
      captureIntervals: this.captureIntervals.slice(-CADENCE_SAMPLES),
      polls: this.polls,
      fullBatches: this.behind,
      conflicts: this.conflicts,
      updatedAt: at,
    };
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 1) + "\n");
    renameSync(temp, this.statePath);
  }
}

// One poll cycle. Returns how long to wait before the next one.
//
// The pacing is the whole game. A full batch (LIMIT records) means the server
// had more to give than it could fit in one answer — we are behind eviction and
// must come straight back. A short batch means we are ahead, and can afford to
// wait. Nothing here is a fixed cadence guess; it is driven by what the room
// just did.
async function step(store) {
  const body = await readRoom(store.room, store.cursor);
  store.polls += 1;
  // The server answered. Remembering that separately from the last capture is
  // what lets the stall report say whether we lost the room or the room simply
  // went quiet — two very different holes in coverage.
  store.lastReadAt = now();
  // sort defensively: every ordering assumption below is about sequence order,
  // not about the order the server happened to serialise them in
  const messages = (body.messages ?? []).slice().sort((a, b) => a.seq - b.seq);

  if (messages.length === 0) {
    // nothing new. the room's own head tells us whether that is really true or
    // whether our cursor has been left behind by the ring.
    const head = body.last_seq ?? store.cursor;
    if (head > store.cursor) store.noteLoss(store.cursor + 1, head, "server reported newer records it would not serve from this cursor");
    return 2000;
  }

  const first = messages[0].seq;
  const last = messages[messages.length - 1].seq;

  // anything between our cursor and the oldest record still served is gone
  if (first > store.cursor + 1) {
    store.noteLoss(store.cursor + 1, first - 1, "evicted from the ring before capture reached it");
  }

  // A sequence missing from inside a response is the one hole that could slip
  // through silently: the cursor jumps to the last record in the batch, so that
  // sequence is never asked for again and nothing else would notice it left.
  for (let i = 1; i < messages.length; i += 1) {
    const previous = messages[i - 1].seq;
    const current = messages[i].seq;
    if (current > previous + 1) store.noteLoss(previous + 1, current - 1, "absent from a response that spanned it");
  }

  store.absorb(messages);
  store.cursor = Math.max(store.cursor, last);

  // track what the room is actually doing, smoothed, so one quiet or one busy
  // poll cannot swing the pacing
  const at = Date.now();
  if (store.ratedAt) {
    const elapsed = (at - store.ratedAt) / 1000;
    if (elapsed >= 0.2) {
      const observed = messages.length / elapsed;
      store.rate = store.rate ? store.rate * 0.7 + observed * 0.3 : observed;
    }
  }
  store.ratedAt = at;

  if (messages.length >= LIMIT) {
    // the answer was capped, so there was more than it would give: we are behind
    // eviction, not ahead of it. come straight back and stop pacing politely.
    store.behind += 1;
    store.rate = Math.max(store.rate ?? 0, LIMIT);
    return 0;
  }

  const wait = store.rate > 0 ? (TARGET_BATCH / store.rate) * 1000 : 2000;
  return Math.max(MIN_WAIT, Math.min(MAX_WAIT, wait));
}

async function follow(store, until) {
  while (Date.now() < until) {
    let wait = 1500;
    try {
      wait = await step(store);
    } catch (error) {
      // a read failure is not an empty room and is not a gap yet: hold the
      // cursor, back off, and let the next successful read tell us what we lost
      console.error(`${store.room}: read failed — ${error.message}`);
      wait = 3000;
    }
    if (wait) await sleep(wait);
  }
}

// -------------------------------------------------------------------- run loop

// Two live recorders appending to one store would interleave batches mid-line
// and corrupt the archive, and a workflow restart makes that easy to cause by
// accident. Take a pidfile lock; a stale one from a killed process is fine to
// steal, a live one is not.
//
// Exclusive create, not exists-then-write: two recorders started in the same
// instant would both pass an existence check and then interleave their batches
// into one append-only store. Only the loser of an atomic create looks at the
// lock at all, and it may take it only if the pid behind it is gone.
function claimLock(lock, alreadyCleared = false) {
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST" || alreadyCleared) return false;
    const held = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    try {
      process.kill(held, 0);
      alive = held !== process.pid;
    } catch {
      alive = false;
    }
    if (alive) return false;
    console.log(`clearing a stale lock from pid ${held}`);
    try {
      unlinkSync(lock);
    } catch {
      // someone else cleared it first — the retry below decides who wins
    }
    return claimLock(lock, true);
  }
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const LOCK = `${DIR}recorder.pid`;

  if (!claimLock(LOCK)) {
    console.error(`another recorder holds ${LOCK} — refusing to double-append to ${DIR}`);
    process.exit(1);
  }

  const stores = ROOMS.map((room) => new RoomStore(room));
  for (const store of stores) {
    store.load();
    // Before capturing a single new record, account for the silence this
    // process slept through. Whatever killed the last recorder, the rooms kept
    // moving, and starting up clean would quietly certify coverage we never had.
    store.watch(now(), "the recorder was not running");
  }

  const until = MINUTES > 0 ? Date.now() + MINUTES * 60000 : Number.MAX_SAFE_INTEGER;
  let stopping = false;

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: flushing state`);
    for (const store of stores) store.flush();
    for (const store of stores) {
      const view = store.liveness();
      console.log(`${store.room}: ${store.held.size} held, +${store.captured} this run, ${store.polls} polls, ` +
        `${store.behind} full batches, ${store.lost.reduce((n, g) => n + (g.to - g.from + 1), 0)} lost to eviction, ` +
        `${view.interruptions} interruptions totalling ${Math.round(view.unrecordedSeconds)}s unrecorded`);
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // The heartbeat. Every tick re-judges capture against the cadence each room
  // has actually been running at, so a stall is on the record within a tick or
  // two rather than whenever someone next reads the log.
  const ticker = setInterval(() => {
    const at = now();
    const views = stores.map((store) => store.watch(at));
    for (const store of stores) store.flush();
    const summary = stores.map((s, i) => {
      const view = views[i];
      const mark = view.state === "recording" ? "" : ` ${view.state.toUpperCase()} ${Math.round(view.captureAgeSeconds ?? 0)}s`;
      return `${s.room} seq ${s.cursor} (+${s.captured})${mark}`;
    }).join("  |  ");
    console.log(`${at}  ${summary}`);
  }, 15000);

  await Promise.all(stores.map((store) => follow(store, until)));
  clearInterval(ticker);
  shutdown("window complete");
}

// Only a direct run follows the rooms. Importing this file has to be inert —
// test.mjs loads RoomStore to replay the resume path against a throwaway store,
// and a claimed lock or a live poll loop would make that untestable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
