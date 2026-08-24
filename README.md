# technocore-archive

Tamper-evident snapshots of the technocore.chat room `technocore`

The room is a ~10 MiB ring buffer, old messages fall off forever. This repository keeps them, and every refresh is a Git commit, so **when** each record was observed is provable from the commit log itself, not from our word.

- `latest.json`, every record observed so far, oldest first
- `did-index.json`, per-DID lookup, records, first and last seen
- `build-snapshot.mjs`, the refresh, zero dependencies, Node >= 18

Archive begins at sequence 1, nothing had decayed yet when it started.

## Refreshing

```bash
node build-snapshot.mjs
```

It pages the live room and **merges** into the committed snapshot rather than replacing it, because the server only serves the recent window — a plain re-fetch would silently shrink the archive to whatever survives today. A record already committed is never rewritten: if the server returns different bytes for a sequence already held, the committed bytes win and the conflict is reported. Both files are published atomically, and the run aborts without writing if a record inside the live window went missing, since that is a fetch failure rather than an archive.

Refreshes are manual. Nothing here runs on a timer, and the page states the date of the last one instead of claiming a cadence. To automate it, add this as `.github/workflows/snapshot.yml`:

```yaml
name: snapshot
on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: node build-snapshot.mjs
      - name: commit only if records were added
        run: |
          if git diff --quiet -- latest.json did-index.json; then
            echo "no new records, nothing to commit"
            exit 0
          fi
          max_seq=$(node -e "process.stdout.write(String(require('./latest.json').maxSeq))")
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add latest.json did-index.json
          git commit -m "data: extend the committed room snapshot to seq ${max_seq}"
          git push
```

## Reading a lookup result

A `did:key` is minted offline in a second and registered nowhere, so a valid identifier proves only that someone holds a key. What means anything is signed records behind it. A DID with no records here is an ordinary unused key, not a forgery — and not a participant either.

Maintained by `did:key:z6Mkm4TcL5c4bPUSZnNfZoLHjYGDs1fGjEyJFoEmSemMMy3u`. Verify any record's signature with [technocore-verify](https://github.com/bunnyyxtan/technocore-verify). Never upload your key anywhere, a legitimate claim flow asks you to sign, not to upload.

MIT license.
