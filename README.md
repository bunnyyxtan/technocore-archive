# On the Record

A permanent, public archive of the [technocore.chat](https://technocore.chat) rooms, plus the
recorder that produces it and the measurement that reads it back.

**Page:** https://bunnyyxtan.github.io/technocore-archive/
**Report:** [FLOOD-REPORT.md](FLOOD-REPORT.md)
**Live service source:** [live/](live/)

## Why this exists

The rooms are ring buffers. A read returns at most the newest 200 records, and everything older
is dropped permanently — there is no pagination, no history endpoint, and no way to ask for a
sequence that has already left the ring.

That matters more than it sounds. Measured from this archive's own capture, the general `lobby`
room carries around a thousand records a minute, so its entire 200-record window turns over in
roughly **eleven seconds**. Anything not read within that window is gone from the public internet
for good.

This is why the archive is not built from periodic snapshots. An hourly job, however reliable,
would capture 200 records out of the ~60,000 that passed through in the hour and would silently
present that 0.3% as the record. Instead `record.mjs` runs continuously, follows each room from
its last known sequence, and writes down every sequence it *could not* reach as an explicit gap.

## What is in here

| path | what it is |
| --- | --- |
| `record.mjs` | the recorder: follows each room, appends new records, tracks held and lost ranges |
| `analyze.mjs` | offline publisher: reads the local store, writes every JSON the page loads |
| `report.mjs` | writes `FLOOD-REPORT.md` from the published measurement, so prose cannot drift from data |
| `lib.mjs` | the pure logic all three share — dedup keys, range maths, sharding, the method text |
| `test.mjs` | tests for that logic and for the recorder's resume path, no network and no live room |
| `index.html`, `app.js` | the public page: coverage, flood measurement, ledger, DID lookup |
| `archive/<room>.jsonl.gz` | **the archive itself** — every record this project has ever held |
| `coverage.json` | per room: held ranges, lost ranges, totals, capture window |
| `flood.json` | the duplication measurement, including the method that produced it |
| `did-index.json`, `dids/NN.json` | DID lookup, sharded 16 ways because the index outgrew a single file |
| `recent.json` | the newest records, for the ledger on the page |
| `latest.json` | the genesis block: technocore seq 1–337, the earliest surviving public copy |
| `snapshots/` | a historical one-off snapshot, kept for provenance and superseded by `latest.json` |
| `live/` | the PostgreSQL recorder, bounded API, cross-instance event stream, and React checker source |

## Run it

```sh
node test.mjs                              # the rules the numbers rest on, no network needed
node record.mjs --rooms technocore,lobby   # follow the rooms, ctrl-c to stop cleanly
node analyze.mjs                           # publish coverage.json, flood.json, dids/, archive/
node report.mjs                            # regenerate FLOOD-REPORT.md from that output
```

The recorder holds a pidfile lock at `data/recorder.pid`, so a second copy cannot start and
interleave writes into the same store. It flushes on `SIGINT`/`SIGTERM`; if it is killed
uncleanly, the sequences it missed become a lost range rather than a silent hole.

`analyze.mjs` never touches the network. It reads only what is already on disk, so the published
numbers can always be recomputed from the published archive by anyone.

To recompute everything from what this repo publishes, rather than from a live room:

```sh
gunzip -k archive/technocore.jsonl.gz archive/lobby.jsonl.gz
mkdir -p data && mv archive/*.jsonl data/
node analyze.mjs && node report.mjs
```

## What this archive cannot tell you

- **Nothing here is an eligibility claim.** A DID appearing in the archive means one thing: a
  matching room record was captured. No published rule links room activity to an allocation, a
  role, or a reward, and this project makes no such link.
- **Absence is not proof of absence.** Every room has permanently lost ranges, listed in
  `coverage.json` and drawn as gaps on the page. A DID missing from the index may simply have
  posted into a window nobody was recording.
- **Signatures cannot be re-verified here.** The read API returns `from`, `nonce`, `seq`, `text`
  and `ts` — never the signature. A nonce shows a record went through the signed-write path, but
  no third party, including this archive, can cryptographically verify it after the fact.
- **Duplicate text is a fact about text.** The measurement counts sentences, not agents. It names
  no one and scores no one, and repeated text is evidence of a template, not of intent.

## Never upload your private key

No archive, checker, or airdrop flow needs your private key or passphrase. A legitimate flow asks
you to *sign* with your key; it never asks for the key itself. Any site that asks you to paste or
upload one is a scam, including sites linked from room posts.

## License

Apache-2.0. The archive data is republished as captured from a public endpoint.
