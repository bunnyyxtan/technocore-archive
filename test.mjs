#!/usr/bin/env node
// Offline tests for everything the archive claims. No network, no fixtures on
// disk: if a number appears on the page, the rule that produced it is checked
// here against text written by hand.
//
//   node test.mjs

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "./record.mjs";
import {
  tidy,
  same,
  toRanges,
  missingRanges,
  countRanges,
  exactKey,
  templateKey,
  group,
  measure,
  buildIndex,
  MAX_SEQS,
  MAX_SAMPLES,
  SAMPLE_CHARS,
  SHARDS,
  shardOf,
  shardName,
  CADENCE_SAMPLES,
  MIN_STALL_SECONDS,
  STOP_MULTIPLE,
  captureCadence,
  captureThresholds,
  captureState,
} from "./lib.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const at = (n) => `2026-08-25T13:${String(n).padStart(2, "0")}:00.000000Z`;
let seq = 1000;
const rec = (from, text, minute = 0, nonce = null) => ({
  from,
  ...(nonce ? { nonce } : {}),
  seq: seq++,
  text,
  ts: at(minute),
});

// --------------------------------------------------------------- record shape

test("tidy fixes key order and drops a null nonce", () => {
  const out = tidy({ ts: "t", text: "hello", seq: 5, from: "a", nonce: null });
  assert.deepEqual(Object.keys(out), ["from", "seq", "text", "ts"]);
  const signed = tidy({ ts: "t", text: "hello", seq: 5, from: "a", nonce: 7 });
  assert.deepEqual(Object.keys(signed), ["from", "nonce", "seq", "text", "ts"]);
});

test("same compares every field a record carries", () => {
  const a = { from: "x", seq: 1, text: "t", ts: "ts", nonce: 4 };
  assert.ok(same(a, { ...a }));
  assert.ok(!same(a, { ...a, text: "other" }));
  assert.ok(!same(a, { ...a, nonce: 5 }));
  assert.ok(!same(a, { ...a, ts: "later" }));
});

// -------------------------------------------------------------- coverage maths

test("toRanges collapses runs and survives gaps, duplicates and disorder", () => {
  assert.deepEqual(toRanges([3, 1, 2]), [[1, 3]]);
  assert.deepEqual(toRanges([1, 2, 5, 6, 9]), [[1, 2], [5, 6], [9, 9]]);
  assert.deepEqual(toRanges([4, 4, 4]), [[4, 4]]);
  assert.deepEqual(toRanges([]), []);
});

test("missingRanges names exactly what is not held", () => {
  assert.deepEqual(missingRanges([[1, 337], [54492, 54800]], 54800), [[338, 54491]]);
  assert.deepEqual(missingRanges([[5, 9]], 12), [[1, 4], [10, 12]]);
  assert.deepEqual(missingRanges([[1, 10]], 10), []);
});

test("countRanges counts inclusively, so a one-record gap counts as one", () => {
  assert.equal(countRanges([[1, 337]]), 337);
  assert.equal(countRanges([[9, 9]]), 1);
  assert.equal(countRanges([[1, 2], [10, 11]]), 4);
});

// -------------------------------------------------------------- normalisation

test("exactKey only collapses whitespace, so different sentences stay different", () => {
  assert.equal(exactKey("  hello   world \n"), "hello world");
  assert.notEqual(exactKey("hello world"), exactKey("hello  worlds"));
});

test("the same sentence from two keys collapses to one template", () => {
  const a = "I published a Technocore contribution: https://x.com/alice/status/123. Agent DID: did:key:z6MkiKEd8txLxNsfhPu5g7yps74LQLdk7qy1r3JjrRF55CU6";
  const b = "I published a Technocore contribution: https://x.com/bob/status/999. Agent DID: did:key:z6MkuAs37MfHyNmAhpny1wL5dd8YUvS4krgqJT44zWE3gjUi";
  assert.notEqual(exactKey(a), exactKey(b), "they are not verbatim identical");
  assert.equal(templateKey(a), templateKey(b), "but they are the same template");
  assert.ok(templateKey(a).includes("<did>"));
  assert.ok(templateKey(a).includes("<url>"));
});

test("template matching does not collapse genuinely different posts", () => {
  const a = "Shipped an offline verifier for signed records on this service.";
  const b = "I published a Technocore contribution: it helps people create a DID.";
  assert.notEqual(templateKey(a), templateKey(b));
});

test("a bare host counts as a URL, and a contract address as a blob", () => {
  assert.equal(
    templateKey("join at technocore.chat now"),
    templateKey("join at flop.finance now"),
  );
  assert.equal(
    templateKey("CA GQkzc2FFsC3e42P7qRAmFkMpNMxTGD2LDrmR3bLNpump"),
    templateKey("CA H1S3oSq5YEvuGTSGgyrshWWgi8MQ6CfeJMQd4CXxpump"),
  );
});

test("punctuation, case and emoji do not create false uniqueness", () => {
  assert.equal(templateKey("Hello, Technocore!"), templateKey("hello technocore 🌸"));
});

test("an empty or missing text never becomes a group key", () => {
  assert.equal(templateKey(""), "");
  assert.equal(templateKey(null), "");
  assert.equal(group([{ from: "a", text: "", ts: at(0), seq: 1 }], templateKey).size, 0);
});

// ----------------------------------------------------------------- measurement

test("measure separates a shared template from an identity repeating itself", () => {
  const shared = (who, n) => rec(who, `I published a Technocore contribution: https://x.com/${who}/status/${n}.`, 0);
  const records = [
    shared("alice", 1),
    shared("bob", 2),
    shared("carol", 3),
    rec("dave", "Same words twice.", 0),
    rec("dave", "Same words twice.", 0),
    rec("erin", "An entirely original field note about read latency.", 0),
  ];
  const m = measure(records);

  assert.equal(m.records, 6);
  assert.equal(m.identities, 5);

  // dave's two identical posts are the only verbatim duplicate pair
  assert.equal(m.exact.duplicatedRecords, 2);

  // alice, bob and carol share one template across three identities
  assert.equal(m.template.sharedGroups, 1);
  assert.equal(m.template.sharedRecords, 3);
  assert.equal(m.template.sharedShare, 50);

  // erin wrote something no one else did; dave only repeated himself
  assert.equal(m.posters.withOriginalText, 1);
  assert.equal(m.posters.sharedTemplateOnly, 3);
  assert.equal(m.posters.selfRepeatOnly, 1);
});

test("a template one identity posts alone is never counted as shared", () => {
  const m = measure([
    rec("solo", "ping", 0),
    rec("solo", "ping", 0),
    rec("solo", "ping", 0),
  ]);
  assert.equal(m.template.sharedGroups, 0);
  assert.equal(m.template.sharedRecords, 0);
  assert.equal(m.template.duplicatedRecords, 3, "still duplicated text, just not shared");
  assert.equal(m.posters.sharedTemplateOnly, 0);
  assert.equal(m.posters.selfRepeatOnly, 1);
});

test("signed writes are counted apart from nicknamed ones", () => {
  const m = measure([
    rec("did:key:z6Mktest", "signed one", 0, 1787585191480),
    rec("human", "unsigned one", 0),
  ]);
  assert.equal(m.signedRecords, 1);
  assert.equal(m.signedShare, 50);
});

test("the timeline buckets by minute and keeps the shared share per bucket", () => {
  const m = measure([
    rec("a", "I published a Technocore contribution: https://x.com/a/1.", 5),
    rec("b", "I published a Technocore contribution: https://x.com/b/2.", 5),
    rec("c", "a genuinely different sentence entirely", 6),
  ]);
  assert.equal(m.timeline.length, 2);
  assert.equal(m.timeline[0].records, 2);
  assert.equal(m.timeline[0].sharedTemplate, 2);
  assert.equal(m.timeline[0].sharedShare, 100);
  assert.equal(m.timeline[1].sharedTemplate, 0);
});

test("an empty window produces zeros rather than NaN", () => {
  const m = measure([]);
  assert.equal(m.records, 0);
  assert.equal(m.exact.duplicateShare, 0);
  assert.equal(m.template.sharedShare, 0);
  assert.equal(m.posters.originalShare, 0);
});

test("top templates are ranked by records and carry their identity spread", () => {
  const records = [];
  for (let i = 0; i < 5; i++) records.push(rec(`who${i}`, `I published a Technocore contribution: https://x.com/who${i}/1.`, 0));
  for (let i = 0; i < 2; i++) records.push(rec(`other${i}`, `Joined via the starter, learning the protocol in the open ${i > 0 ? "!" : "."}`, 0));
  const m = measure(records);
  assert.equal(m.topTemplates[0].records, 5);
  assert.equal(m.topTemplates[0].identities, 5);
  assert.ok(m.topTemplates[0].shareOfWindow > 50);
});

// ---------------------------------------------------------------- the index

test("the index caps stored sequences but never the true count", () => {
  const records = [];
  for (let i = 0; i < MAX_SEQS + 9; i++) records.push(rec("busy", `note ${i}`, 0));
  const index = buildIndex({ technocore: records });
  assert.equal(index.busy.count, MAX_SEQS + 9);
  assert.equal(index.busy.seqs.length, MAX_SEQS);
});

test("the index spans rooms and records where each identity was seen", () => {
  const index = buildIndex({
    technocore: [rec("both", "hello there", 0)],
    lobby: [rec("both", "hello there", 1), rec("lobbyonly", "hi", 1)],
  });
  assert.equal(index.both.count, 2);
  assert.deepEqual(index.both.rooms, { technocore: 1, lobby: 1 });
  assert.equal(index.lobbyonly.rooms.technocore, undefined);
});

test("the index marks how many of an identity's records share text with others", () => {
  const index = buildIndex({
    lobby: [
      rec("a", "I published a Technocore contribution: https://x.com/a/1.", 0),
      rec("b", "I published a Technocore contribution: https://x.com/b/2.", 0),
      rec("a", "something only a said", 0),
    ],
  });
  assert.equal(index.a.count, 2);
  assert.equal(index.a.shared, 1, "one of a's two records matches another identity's template");
  assert.equal(index.b.shared, 1);
});

// These vectors are pinned on purpose. app.js computes the same bucket in the
// browser from its own copy of shardOf, and if the two ever disagree every
// lookup quietly reads the wrong file and reports "no records" for identities
// that are in the archive. Changing the hash has to break this test.
test("shardOf is pinned, in range, and total", () => {
  assert.equal(shardOf("did:key:z6Mkm4TcL5c4bPUSZnNfZoLHjYGDs1fGjEyJFoEmSemMMy3u", 16), 0);
  assert.equal(shardOf("did:key:z6MkiKEd8txLxNsfhPu5g7yps74LQLdk7qy1r3JjrRF55CU6", 16), 10);
  assert.equal(shardOf("", 16), 5);

  var seen = new Set();
  for (var i = 0; i < 400; i++) {
    var bucket = shardOf("did:key:z6Mktest" + i, SHARDS);
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < SHARDS, "bucket in range");
    seen.add(bucket);
  }
  assert.equal(seen.size, SHARDS, "400 identities reach every bucket");
});

test("shardName zero pads so the published paths sort", () => {
  assert.equal(shardName(0), "dids/00.json");
  assert.equal(shardName(15), "dids/15.json");
});

test("archive-wide excerpts stay bounded and mark signed identities", () => {
  const long = "x".repeat(400);
  const records = Array.from({ length: MAX_SAMPLES + 4 }, (_, i) =>
    rec("did:key:z6Mkwho", `${i}:${long}`, i, i === 0 ? 12345 : null));
  const entry = buildIndex({ lobby: records })["did:key:z6Mkwho"];
  assert.equal(entry.samples.length, MAX_SAMPLES);
  assert.deepEqual(entry.samples.map((sample) => sample.seq), records.slice(0, MAX_SAMPLES).map((record) => record.seq));
  assert.ok(entry.samples.every((sample) => sample.room === "lobby"));
  assert.ok(entry.samples.every((sample) => sample.text.length <= SAMPLE_CHARS + 1));
  assert.ok(entry.samples.every((sample) => sample.text.endsWith("…")));
  assert.equal(entry.signed, true);
});

test("old contributions remain displayable after they leave recent.json", () => {
  const did = "did:key:z6Mkm4TcL5c4bPUSZnNfZoLHjYGDs1fGjEyJFoEmSemMMy3u";
  const old = [48, 65, 92].map((recordSeq, i) => ({
    from: did,
    nonce: 1787584498527 + i,
    seq: recordSeq,
    text: `archived contribution ${recordSeq}`,
    ts: at(i),
  }));
  const newer = Array.from({ length: 300 }, (_, i) => ({
    from: `did:key:z6Mknew${i}`,
    seq: 1000 + i,
    text: `newer record ${i}`,
    ts: at(10),
  }));
  const recent = newer.slice(-300);
  assert.equal(recent.some((record) => record.from === did), false);

  const entry = buildIndex({ technocore: [...old, ...newer] })[did];
  assert.deepEqual(entry.samples.map((sample) => sample.seq), [48, 65, 92]);
  assert.deepEqual(entry.samples.map((sample) => sample.text), [
    "archived contribution 48",
    "archived contribution 65",
    "archived contribution 92",
  ]);
});

// The whole honesty claim of coverage.json rests on this: whatever is not held
// is lost, and the two together are exactly the room. Deriving loss this way is
// what stops a repeated "we could not reach the head" note from being counted
// twice and inflating how much the ring is said to have destroyed.
test("held plus lost always accounts for the room exactly once", () => {
  const cases = [
    { held: [[1, 10], [20, 30]], maxSeq: 40, lost: [[11, 19], [31, 40]] },
    { held: [[5, 10]], maxSeq: 10, lost: [[1, 4]] },
    { held: [[1, 3]], maxSeq: 3, lost: [] },
    { held: [[222802, 223781], [228708, 239534]], maxSeq: 239534, lost: [[1, 222801], [223782, 228707]] },
  ];
  for (const { held, maxSeq, lost } of cases) {
    assert.deepEqual(missingRanges(held, maxSeq), lost);
    assert.equal(countRanges(held) + countRanges(missingRanges(held, maxSeq)), maxSeq, "no sequence counted twice or dropped");
  }
});

// Two copies of the same hash exist by necessity — one publishes the buckets,
// one picks a bucket in the browser — so the only thing keeping a lookup
// working is that they agree. Compare the real browser source, not a copy of
// it: a copy would drift with the original and prove nothing.
test("the browser copy of the shard hash matches the publisher's", () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("function shardOf(");
  assert.ok(start >= 0, "app.js still defines shardOf — if it was renamed, this test must follow it");

  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > start, "found a brace-balanced shardOf in app.js");

  const browserShardOf = new Function(`${source.slice(start, end)} return shardOf;`)();
  for (let i = 0; i < 500; i += 1) {
    const did = `did:key:z6Mk${i.toString(36)}Qw${i * 7919}`;
    assert.equal(browserShardOf(did, SHARDS), shardOf(did, SHARDS), `browser and publisher disagree on ${did}`);
  }
  assert.equal(browserShardOf("", SHARDS), shardOf("", SHARDS));
  assert.equal(browserShardOf("kirit", SHARDS), shardOf("kirit", SHARDS));
});

// ------------------------------------------------------------- store resume
//
// Everything above this line is pure. This section is not, and has to be: the
// crash it exists to catch only happens against a store on disk, at a size no
// test of the pure logic would ever reach.
//
// What happened: resuming took the highest held sequence with Math.max(...held),
// which spreads one argument per record. That is correct for a few hundred
// records and fatal for a hundred thousand — once lobby held ~145k sequences the
// recorder died on startup with "Maximum call stack size exceeded", capture
// stopped, and nothing in the suite noticed because nothing here had ever loaded
// a store. The fix is a fold. This is the test that would have caught it.

// The ceiling belongs to the engine, not to us: it moves with the Node version,
// the stack size and the depth of the frame doing the spreading. Measure it
// instead of pinning a number that would quietly stop meaning anything.
function spreadCeiling(cap = 1 << 21) {
  for (let size = 4096; size <= cap; size *= 2) {
    try {
      Math.max(...new Array(size).fill(0));
    } catch {
      return size; // a size this engine has just refused to spread
    }
  }
  return null;
}

test("a store far past the spread ceiling resumes at its true highest sequence", () => {
  const ceiling = spreadCeiling();
  assert.ok(
    ceiling,
    "no argument-spread ceiling found below 2^21 on this engine, so this test can no longer reproduce the crash it guards — revisit it rather than deleting it",
  );

  // a temporary directory, never data/: the live rooms and the committed store
  // are not fixtures and must not be read, written or locked by a test run
  const dir = mkdtempSync(join(tmpdir(), "technocore-archive-resume-"));
  const narrate = console.log;
  try {
    const first = 222802; // where lobby's held range actually begins
    const seqs = Array.from({ length: ceiling }, (_, i) => first + i);
    const highest = seqs[seqs.length - 1];

    // The server does not promise to serialise a batch in sequence order — the
    // recorder sorts every response for exactly that reason — so the last line
    // of a store is not necessarily the highest sequence in it. Put the highest
    // at the head of the final batch, so nothing can pass this by reading the
    // last line instead of taking a real maximum.
    const tail = seqs.slice(-200);
    const ordered = seqs.slice(0, -200).concat([highest], tail.slice(0, -1));
    assert.notEqual(ordered[ordered.length - 1], highest, "the fixture's last line is not its highest sequence");

    const path = join(dir, "lobby.jsonl");
    writeFileSync(path, ordered.map((seq) => JSON.stringify({
      from: `did:key:z6Mkfixture${seq % 97}`,
      seq,
      text: `held record ${seq}`,
      ts: at(0),
    })).join("\n") + "\n");

    // and a torn final line, because the recorder that has to resume is usually
    // one that was killed mid-append
    appendFileSync(path, '{"from":"did:key:z6Mkfixture1","seq":');

    const store = new RoomStore("lobby", dir);
    console.log = () => {}; // the loader narrates to the operator, not to the suite
    store.load();
    console.log = narrate;

    // the assertion the recorder's uptime rests on
    assert.equal(store.cursor, highest, "resumed at the true highest sequence on disk");
    assert.equal(store.held.size, ordered.length, "every complete record is held");
    assert.equal(store.records.size, ordered.length);

    // and the proof that this fixture is big enough to mean something: the old
    // resume path was this expression, and the engine refuses to evaluate it
    assert.throws(
      () => Math.max(...store.held),
      RangeError,
      "the fixture must be past the engine's spread ceiling, or it cannot catch the regression",
    );

    // flush walks the whole held set through toRanges on every tick, so it is
    // the other unbounded pass over held sequences: cover it at the same size
    store.flush();
    const state = JSON.parse(readFileSync(join(dir, "lobby.state.json"), "utf8"));
    assert.equal(state.cursor, highest);
    assert.equal(state.maxSeq, highest);
    assert.equal(state.records, ordered.length);
    assert.deepEqual(state.heldRanges, [[first, highest]], "one contiguous run, however many records it spans");
    assert.equal(countRanges(state.heldRanges), ordered.length);
  } finally {
    console.log = narrate;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Strip comments before scanning source, so prose about the bug is not mistaken
// for the bug. Quoted text survives: record.mjs holds a "https://" base URL that
// a naive scan would read as the start of a comment.
// ------------------------------------------------------ noticing a dead recorder

test("cadence comes from the room's own intervals, and the median ignores an outage", () => {
  const steady = new Array(40).fill(3);
  assert.deepEqual(captureCadence(steady), { samples: 40, heartbeatSeconds: 3, jitterSeconds: 3 });

  // one hour-long hole among forty three-second beats. A mean would put the
  // heartbeat at 93s and lift the stall threshold past nine minutes — the next
  // outage would then be invisible for as long as this one lasted.
  const withOutage = steady.slice();
  withOutage[20] = 3600;
  const poisoned = captureCadence(withOutage);
  assert.equal(poisoned.heartbeatSeconds, 3, "the median shrugs off the outage the mean would swallow");
  assert.ok(
    captureThresholds(poisoned).stallAfterSeconds < 60,
    "so the threshold after an outage still catches the next one quickly",
  );

  // and it follows the room rather than the whole history
  const changed = new Array(CADENCE_SAMPLES + 60).fill(0.2);
  for (let i = 0; i < 60; i += 1) changed[i] = 600; // ancient, slow, and outside the window
  assert.equal(captureCadence(changed).heartbeatSeconds, 0.2, "only the recent window decides the cadence");
});

test("the stall threshold is measured, never a guess about how fast a room runs", () => {
  // A room that posts three times a second and a room that posts twice an hour
  // get thresholds three orders of magnitude apart, from the same code, with no
  // room-speed constant anywhere between them.
  const fast = captureThresholds(captureCadence(new Array(60).fill(0.33)));
  const slow = captureThresholds(captureCadence(new Array(60).fill(1800)));
  assert.equal(fast.stallAfterSeconds, MIN_STALL_SECONDS, "a very fast room is held to the floor, not to milliseconds");
  assert.equal(fast.derivedFromRoom, false, "and says so, rather than implying the room chose it");
  assert.equal(slow.stallAfterSeconds, 10800, "a slow room gets six of its own beats");
  assert.equal(slow.derivedFromRoom, true);
  assert.ok(slow.stallAfterSeconds > fast.stallAfterSeconds * 300, "the same rule, three orders of magnitude apart");

  // a bursty room is judged on its slowest ordinary beat, not its median one
  const bursty = new Array(60).fill(1);
  for (let i = 0; i < 5; i += 1) bursty[i] = 90; // real, ordinary, and rare
  const thresholds = captureThresholds(captureCadence(bursty));
  assert.ok(thresholds.stallAfterSeconds >= 90, "ordinary jitter must never be reported as a stall");

  // and before a room has shown anything, the floor answers
  const unknown = captureThresholds(captureCadence([]));
  assert.equal(unknown.stallAfterSeconds, MIN_STALL_SECONDS);
  assert.equal(unknown.stopAfterSeconds, MIN_STALL_SECONDS * 4);
  assert.equal(unknown.derivedFromRoom, false);
});

test("capture state separates recording, stalled and stopped", () => {
  const cadence = captureCadence(new Array(40).fill(10)); // stall at 60s, stop at 240s
  assert.equal(captureState(0, cadence), "recording");
  assert.equal(captureState(59, cadence), "recording");
  assert.equal(captureState(60, cadence), "stalled");
  assert.equal(captureState(239, cadence), "stalled");
  assert.equal(captureState(240, cadence), "stopped");

  // "starting" is only ever the answer before the first record of all: once a
  // room has captured once, silence is measured rather than excused
  assert.equal(captureState(null, cadence), "starting");
  assert.equal(captureState(99999, captureCadence([])), "stopped", "an unknown cadence must not excuse silence");
});

test("a recorder that was not running writes the silence it slept through into the ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "technocore-archive-stall-"));
  const narrate = { log: console.log, error: console.error };
  try {
    // a store left behind by a recorder that died: steady 3s cadence, last
    // record twenty minutes ago
    const died = "2026-08-25T13:00:00.000Z";
    writeFileSync(join(dir, "lobby.state.json"), JSON.stringify({
      room: "lobby",
      cursor: 500,
      lost: [],
      firstCaptureAt: "2026-08-25T12:00:00.000Z",
      lastCaptureAt: died,
      lastReadAt: died,
      captureIntervals: new Array(40).fill(3),
      outages: [],
    }));
    writeFileSync(join(dir, "lobby.jsonl"), "");

    const store = new RoomStore("lobby", dir);
    console.log = () => {};
    console.error = () => {};
    store.load();
    const view = store.watch("2026-08-25T13:20:00.000Z", "the recorder was not running");
    console.log = narrate.log;
    console.error = narrate.error;

    assert.equal(store.lastCaptureAt, died, "the last capture before the crash is restored, not reset");
    assert.equal(view.state, "stopped", "twenty minutes of silence in a three-second room is not a hiccup");
    assert.equal(store.outages.length, 1, "and it is on the record without anyone reading a log");
    assert.equal(store.outages[0].to, null, "left open, because capture has not come back yet");
    assert.equal(store.outages[0].reason, "the recorder was not running");
    assert.equal(Math.round(view.unrecordedSeconds), 1200);
    assert.equal(view.interrupted, true);

    // the ring destroyed records while nobody was there: both ledgers must name
    // the same hole, or the coverage numbers disagree with each other
    console.error = () => {};
    store.noteLoss(501, 4000, "evicted from the ring before capture reached it");
    console.error = narrate.error;
    assert.equal(store.outages[0].lostFrom, 501);
    assert.equal(store.outages[0].lostTo, 4000);
    assert.equal(store.lost.length, 1, "and the eviction note itself is unchanged");

    // capture resumes: the interruption closes, and the twenty-minute gap is
    // never mistaken for the room's cadence
    console.log = () => {};
    store.absorb([{ seq: 4001, from: "did:key:zA", text: "back", ts: "2026-08-25T13:20:01.000000Z" }]);
    console.log = narrate.log;
    assert.ok(store.outages[0].to, "the interruption is closed by the first record back");
    assert.equal(store.captureIntervals.length, 40, "the outage-spanning gap is not recorded as a beat");
    assert.equal(store.liveness().state, "recording");
    assert.equal(store.liveness().interrupted, false);
    assert.ok(store.liveness().unrecordedSeconds >= 1200, "but the time it cost stays counted forever");

    // and the whole account survives a flush/reload, which is the only way the
    // next process can know any of it happened
    store.flush();
    const written = JSON.parse(readFileSync(join(dir, "lobby.state.json"), "utf8"));
    assert.equal(written.captureState, "recording");
    assert.equal(written.outages.length, 1);
    assert.ok(written.unrecordedSeconds >= 1200);
    assert.equal(written.stallAfterSeconds, 30, "the measured threshold travels with the store");
  } finally {
    console.log = narrate.log;
    console.error = narrate.error;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a room that answers but has nothing new is not reported as a lost room", () => {
  const dir = mkdtempSync(join(tmpdir(), "technocore-archive-quiet-"));
  const narrate = console.error;
  try {
    writeFileSync(join(dir, "lobby.state.json"), JSON.stringify({
      room: "lobby",
      cursor: 10,
      lastCaptureAt: "2026-08-25T13:00:00.000Z",
      lastReadAt: "2026-08-25T13:01:55.000Z", // the server is answering, fine
      captureIntervals: new Array(20).fill(3),
      outages: [],
    }));
    const store = new RoomStore("lobby", dir);
    const say = console.log;
    console.log = () => {};
    console.error = () => {};
    store.load();
    store.watch("2026-08-25T13:02:00.000Z");
    console.log = say;
    console.error = narrate;

    assert.equal(store.outages[0].reason, "the room served no new records");
    assert.notEqual(store.outages[0].reason, "the room could not be read");
  } finally {
    console.error = narrate;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The API server keeps its own capture stream — what actually reached Postgres —
// and judges it with its own copy of this rule, for the same reason shardOf is
// duplicated: neither store may depend on the other being up. Two copies may
// legitimately disagree about a room, but never about what the rule is, so the
// numbers that define it are pinned across both.
test("the api server's copy of the freshness rule uses the same constants", () => {
  const port = new URL("../artifacts/api-server/src/live/freshness.ts", import.meta.url);
  const source = stripComments(readFileSync(port, "utf8"));
  const constant = (name) => Number(source.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`))?.[1].replace(/_/g, ""));
  assert.equal(constant("CADENCE_SAMPLES"), CADENCE_SAMPLES);
  assert.equal(constant("MIN_STALL_SECONDS"), MIN_STALL_SECONDS);
  assert.equal(constant("STOP_MULTIPLE"), STOP_MULTIPLE);
  for (const rule of ["heartbeat * 6", "jitter * 3", 'ageSeconds >= stopAfterSeconds) return "stopped"']) {
    assert.ok(source.includes(rule), `the ported rule must still say: ${rule}`);
  }
});

// The published archive is read long after it is written. A verdict decided at
// publish time would keep saying "recording" to every later reader, which is
// the failure this whole mechanism exists to end — so the publisher ships the
// measurements and the page reaches its own conclusion against its own clock.
test("the published archive ships measurements, not a frozen verdict", () => {
  const analyze = stripComments(readFileSync(new URL("./analyze.mjs", import.meta.url), "utf8"));
  assert.ok(!analyze.includes("captureState"), "coverage.json must not carry a verdict that cannot go stale");
  for (const field of ["lastCaptureAt", "stallAfterSeconds", "stopAfterSeconds", "interruptions", "unrecordedSeconds"]) {
    assert.ok(analyze.includes(field), `coverage must publish ${field} so a reader can judge freshness itself`);
  }

  const page = stripComments(readFileSync(new URL("./app.js", import.meta.url), "utf8"));
  assert.ok(
    page.includes("Date.now() - new Date(state.lastCaptureAt).getTime()"),
    "the page must age the last capture against the clock of whoever is reading it",
  );
  assert.equal(Number(page.match(/state\.stallAfterSeconds \|\| (\d+)/)?.[1]), MIN_STALL_SECONDS);
  assert.equal(Number(page.match(/state\.stopAfterSeconds \|\| stall \* (\d+)/)?.[1]), STOP_MULTIPLE);
});

// Judging at read time only helps the moment the page is read. A tab left open
// through a stall is read once, so the verdict it drew on arrival has to keep
// moving on its own — otherwise the reassurance outlives the recorder, which is
// the exact failure this is here to end. Run the browser's own function.
test("a page left open re-judges instead of keeping the verdict it loaded with", () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const captureStateInBrowser = browserFunction(source, "captureState");
  const published = { stallAfterSeconds: 30, stopAfterSeconds: 120 };
  const aged = (secondsAgo) => ({
    ...published,
    lastCaptureAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  assert.equal(captureStateInBrowser(aged(4)), "recording");
  assert.equal(captureStateInBrowser(aged(29)), "recording");
  assert.equal(captureStateInBrowser(aged(31)), "stalled");
  assert.equal(captureStateInBrowser(aged(119)), "stalled");
  assert.equal(captureStateInBrowser(aged(121)), "stopped");
  assert.equal(captureStateInBrowser(aged(6 * 3600)), "stopped");
  assert.equal(captureStateInBrowser({ ...published, lastCaptureAt: null }), "starting");

  const page = stripComments(source);
  assert.ok(
    /function retimeStatus\(\)[\s\S]{0,240}renderHeader\(\);[\s\S]{0,80}renderCoverage\(\);/.test(page),
    "re-judging must redraw the headline verdict and the per-room chips, not just one of them",
  );
  assert.ok(
    /setInterval\(retimeStatus/.test(page),
    "the page must re-judge on a ticker; a verdict drawn once is a verdict that goes stale",
  );
  assert.ok(
    /function reloadCoverage\(\)[\s\S]{0,200}load\("coverage\.json"\)/.test(page) &&
      /setInterval\(reloadCoverage/.test(page),
    "the page must also re-read the published measurements so a recovered recorder shows up",
  );
  const retimeMs = Number(page.match(/var RETIME_MS = (\d+)/)?.[1]);
  assert.ok(
    retimeMs > 0 && retimeMs <= 15_000,
    "the ticker must be fast enough that a stall is noticed in minutes, not on the next page load",
  );
});

/** Pull a function out of the real browser source and run it here, so the test
 * is pinned to what ships rather than to a copy that would drift with it. */
function browserFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js still defines ${name} — if it was renamed, this test must follow it`);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > start, `found a brace-balanced ${name} in app.js`);
  return new Function(`${source.slice(start, end)} return ${name};`)();
}

function stripComments(source) {
  let out = "";
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2);
      if (i === -1) break;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

// The store test above catches the resume path specifically. This catches the
// same one-character mistake anywhere else in the recorder — including the
// paths a test cannot easily reach — because every one of these builds an
// argument list out of a collection whose size the room decides.
test("nothing in the recorder builds a call's argument list out of a collection", () => {
  assert.equal(stripComments('a = "http://x"; // Math.max(...set)\n/* Math.min(...s) */ b();').includes("Math."), false);
  assert.ok(stripComments("Math.max(...held);").includes("Math.max(...held)"), "and leaves the code itself alone");

  const banned = [
    // one argument per element, and the element count is the room's to decide
    [/(?:Math\.(?:max|min)|\.push|\.concat)\s*\(\s*\.\.\./, "spreads a collection into an argument list"],
    // the same overflow, spelled the way it was spelled before spread syntax
    [/\.apply\s*\(/, "passes an array where an argument list is expected"],
  ];
  for (const file of ["record.mjs", "lib.mjs"]) {
    const lines = stripComments(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).split("\n");
    lines.forEach((text, i) => {
      for (const [pattern, why] of banned) {
        assert.ok(!pattern.test(text), `${file}:${i + 1} ${why} — fold over it instead: ${text.trim()}`);
      }
    });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
