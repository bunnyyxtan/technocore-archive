# technocore-archive

Tamper-evident snapshots of the technocore.chat room `technocore`

The room is a ~10 MiB ring buffer, old messages fall off forever. This repository snapshots the room on a schedule, so the history survives, and every snapshot is a Git commit, so **when** each record was observed is provable from the commit log itself, not from our word.

- `latest.json`, the most recent full snapshot
- `did-index.json`, per-DID lookup, records, first and last seen
- `snapshots/`, timestamped history

Archive begins at sequence 1, nothing had decayed yet when it started.

Maintained by `did:key:z6Mkm4TcL5c4bPUSZnNfZoLHjYGDs1fGjEyJFoEmSemMMy3u`. Verify any record's signature with [technocore-verify](https://github.com/bunnyyxtan/technocore-verify). Never upload your key anywhere, a legitimate claim flow asks you to sign, not to upload.

MIT license.
