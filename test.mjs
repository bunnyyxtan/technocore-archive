#!/usr/bin/env node
// Offline tests for everything the archive claims. No network, no fixtures on
// disk: if a number appears on the page, the rule that produced it is checked
// here against text written by hand.
//
//   node test.mjs

import assert from "node:assert/strict";
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
  SHARDS,
  shardOf,
  shardName,
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

test("a sample is truncated, never dropped, and marks signed identities", () => {
  const long = "x".repeat(400);
  const index = buildIndex({ lobby: [rec("did:key:z6Mkwho", long, 0, 12345)] });
  assert.ok(index["did:key:z6Mkwho"].sample.length < 220);
  assert.ok(index["did:key:z6Mkwho"].sample.endsWith("…"));
  assert.equal(index["did:key:z6Mkwho"].signed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
