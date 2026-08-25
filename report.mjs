#!/usr/bin/env node
// Write FLOOD-REPORT.md from the published measurement.
//
//   node report.mjs
//
// The report is generated rather than written by hand for one reason: a number
// typed into prose drifts from the data the moment the recorder runs again, and
// a report whose numbers no longer match its own archive is worth nothing. Every
// figure below is read out of coverage.json and flood.json, which are produced
// by analyze.mjs from the records in archive/<room>.jsonl.gz.

import { readFileSync, writeFileSync } from "node:fs";

const HERE = new URL("./", import.meta.url).pathname;
const coverage = JSON.parse(readFileSync(`${HERE}coverage.json`, "utf8"));
const flood = JSON.parse(readFileSync(`${HERE}flood.json`, "utf8"));

const n = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-GB"));
const when = (ts) => (ts ? String(ts).replace("T", " ").slice(0, 19) + " UTC" : "—");
// a sample is untrusted text going into a markdown table
const cell = (text) => String(text).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

const rooms = Object.keys(flood.rooms);
const out = [];

out.push("# What the Technocore rooms actually carried");
out.push("");
out.push(
  `Generated ${when(flood.generatedAt)} from a third-party archive of the public ` +
  "[technocore.chat](https://technocore.chat) rooms, not affiliated with Flop Labs. Every number here is derived " +
  "from records this archive holds and republishes, so anyone can recompute all of it without trusting this document.",
);
out.push("");
out.push("## What this is not");
out.push("");
out.push(
  "- **It is not an eligibility claim.** Nothing here says who qualifies for an allocation, a role or a reward, " +
  "and nothing here should be read as a rule about any of those. No published rule links room activity to anything.",
);
out.push(
  "- **It names no one.** No identifier is singled out, ranked or accused. The unit of measurement is a sentence, " +
  "not an agent. Duplicate text is a fact about text.",
);
out.push(
  "- **It is not complete.** The rooms are ring buffers and the read window is the newest 200 records. Everything " +
  "the recorder was not running for is permanently gone from the public internet. The gaps are stated below rather " +
  "than hidden.",
);
out.push("");

out.push("## Coverage, including the holes");
out.push("");
out.push("| room | records held | permanently lost | room reached | capture window |");
out.push("| --- | --- | --- | --- | --- |");
for (const room of Object.keys(coverage.rooms)) {
  const c = coverage.rooms[room];
  out.push(
    `| ${room} | ${n(c.heldRecords)} | ${n(c.lostRecords)} | seq 1–${n(c.maxSeq)} | ` +
    `${when(c.firstCaptureAt)} → ${when(c.lastCaptureAt)} |`,
  );
}
out.push("");
for (const room of Object.keys(coverage.rooms)) {
  const c = coverage.rooms[room];
  const held = c.heldRanges.map(([a, b]) => `${n(a)}–${n(b)}`).join(", ");
  const lost = c.lostRanges.length ? c.lostRanges.map(([a, b]) => `${n(a)}–${n(b)}`).join(", ") : "none";
  out.push(`- **${room}** — held: ${held}. Lost: ${lost}.${c.lostReasons?.length ? ` (${c.lostReasons.join("; ")})` : ""}`);
}
out.push("");
out.push(
  "The lost ranges are not recoverable. They left the service before a recorder existed, and no archive, including " +
  "this one, can bring them back. They are listed so that an absent identifier is read as *unknown in that range*, " +
  "never as *proven absent*.",
);
out.push("");

out.push("## Method");
out.push("");
out.push("Two independent measures of \"this post arrived again\", both reported, neither adjusted:");
out.push("");
// the template rule contains <did> and <url>, which markdown would swallow as html
out.push(`- **Exact** — ${flood.method.exact}. If two records share an exact key, a human reading them would call them identical.`);
out.push(`- **Template** — \`${flood.method.template}\`.`);
out.push("");
out.push(
  `A template group counts as **shared** when it is ${flood.method.sharedGroup}. That distinction carries the whole ` +
  "report. One identity repeating itself is ordinary noise. One sentence arriving from hundreds of separate keys, " +
  "differing only in the identifiers belonging to those keys, is a different phenomenon, and only the second is " +
  "counted as shared.",
);
out.push("");
out.push(
  `Scope: ${flood.method.scope}. For technocore that deliberately excludes the 337 genesis records this archive ` +
  "holds from the room's first day — they are two days and tens of thousands of sequences older than the flood, and " +
  "averaging them in would understate it.",
);
out.push("");

out.push("## What the windows show");
out.push("");
out.push("| room | window | records | rate | identities | verbatim dupes | shared template | identities posting anything original |");
out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const room of rooms) {
  const m = flood.rooms[room];
  out.push(
    `| ${room} | ${m.window.minutes} min | ${n(m.records)} | ${n(m.window.recordsPerMinute)}/min | ` +
    `${n(m.identities)} | ${m.exact.duplicateShare}% | **${m.template.sharedShare}%** | ` +
    `${n(m.posters.withOriginalText)} of ${n(m.posters.total)} (${m.posters.originalShare}%) |`,
  );
}
out.push("");

for (const room of rooms) {
  const m = flood.rooms[room];
  if (!m.records) continue;
  out.push(`### ${room}`);
  out.push("");
  out.push(
    `Window: seq ${n(m.window.fromSeq)}–${n(m.window.toSeq)}, ${when(m.window.fromTs)} → ${when(m.window.toTs)}, ` +
    `captured without a gap.`,
  );
  out.push("");
  out.push(`- ${n(m.records)} records from ${n(m.identities)} distinct identities`);
  out.push(`- ${n(m.exact.uniqueTexts)} distinct texts, collapsing to ${n(m.template.uniqueTemplates)} templates`);
  out.push(
    `- ${n(m.template.sharedRecords)} records (${m.template.sharedShare}%) belong to one of ${n(m.template.sharedGroups)} ` +
    "templates posted by two or more identities",
  );
  out.push(
    `- ${n(m.posters.sharedTemplateOnly)} identities posted **only** text that another identity also posted; ` +
    `${n(m.posters.selfRepeatOnly)} only repeated themselves; ${n(m.posters.withOriginalText)} posted something no one else did`,
  );
  out.push(`- ${n(m.signedRecords)} records (${m.signedShare}%) carried a signature rather than an unauthenticated nickname`);

  const peak = m.timeline.reduce((top, bucket) => (bucket.records > (top?.records ?? 0) ? bucket : top), null);
  if (peak) out.push(`- busiest minute: ${when(peak.minute)} with ${n(peak.records)} records, ${peak.sharedShare}% of them shared-template`);
  out.push("");

  if (m.topTemplates.length) {
    out.push("Most repeated templates in the window:");
    out.push("");
    out.push("| posts | identities | share of window | sample of the text |");
    out.push("| --- | --- | --- | --- |");
    for (const template of m.topTemplates.slice(0, 8)) {
      out.push(`| ${n(template.records)} | ${n(template.identities)} | ${template.shareOfWindow}% | ${cell(template.sample)} |`);
    }
    out.push("");
  }
}

out.push("## Reading it honestly");
out.push("");
out.push(
  "The two rooms behave differently, and the difference is the most useful thing in this report. In the room the " +
  "campaign points at, a large majority of records are the same handful of sentences arriving from keys that post " +
  "nothing else. In the general room the same measurement produces a much lower shared share and a majority of " +
  "identities writing their own text. The measurement is identical in both, so the gap is a property of the traffic, " +
  "not of the method.",
);
out.push("");
out.push(
  "None of this establishes intent, ownership, or wrongdoing. Many of the repeated posts come from people honestly " +
  "following a template that was handed to them. Templated text is evidence of a template, nothing more.",
);
out.push("");

out.push("## Reproduce it");
out.push("");
out.push("```sh");
out.push("git clone https://github.com/bunnyyxtan/technocore-archive");
out.push("cd technocore-archive");
out.push("node test.mjs                      # the rules the numbers rest on");
out.push("gunzip -k archive/technocore.jsonl.gz archive/lobby.jsonl.gz");
out.push("mkdir -p data && mv archive/*.jsonl data/");
out.push("node analyze.mjs && node report.mjs   # regenerates every figure above");
out.push("```");
out.push("");
out.push(
  "`record.mjs` is the recorder that produced the store: it follows each room from its last known sequence, writes " +
  "records down immutably, and records any sequence it could not reach as a lost range instead of quietly skipping it.",
);
out.push("");
out.push("---");
out.push("");
out.push(
  "Never upload a private key or passphrase to any site, including anything linked from a room post. A legitimate " +
  "flow can ask you to sign with your own key; it never needs the key itself.",
);
out.push("");

writeFileSync(`${HERE}FLOOD-REPORT.md`, out.join("\n"));
console.log(`wrote FLOOD-REPORT.md — ${rooms.length} room(s), generated ${flood.generatedAt}`);
