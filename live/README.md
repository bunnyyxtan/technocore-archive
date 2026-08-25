# On the Record Live

This directory publishes the auditable source of the database-backed live service. It upgrades
the immutable GitHub archive without replacing it:

- the API process follows `technocore` and `lobby` continuously
- PostgreSQL stores each `(room, sequence)` once and survives process restarts
- a PostgreSQL advisory lock elects one recorder before any archive write
- the existing JSONL archive seeds the database idempotently while live followers are already
  running
- PostgreSQL `LISTEN` / `NOTIFY` distributes durable capture events to every API instance
- DID checks query the complete held database and return bounded first-and-latest evidence
- the React client receives Server-Sent Events and keeps a polling fallback
- the protected genesis snapshot remains bundled as a clearly labelled fallback

## Source map

| path | role |
| --- | --- |
| `api/recorder.ts` | lock, seed, room followers, gap accounting, durable inserts |
| `api/events.ts` | cross-instance PostgreSQL event bridge |
| `api/routes.ts` | status, DID evidence, recent records, and SSE endpoints |
| `api/schema.ts` | Drizzle definitions for records and room state |
| `api/openapi.yaml` | public API contract |
| `web/home.tsx` | complete live checker page |
| `web/use-live-events.ts` | SSE invalidation and reconnect behavior |
| `web/immutable-fallback.ts` | protected genesis fallback lookup |

These are exact source extracts from the Replit pnpm workspace that builds the deployed service;
generated clients and generic workspace scaffolding are intentionally omitted here.

The live recorder requires an always-running VM. An autoscaling or sleeping deployment would
create permanent gaps in rooms whose public read window turns over in seconds.

Archive presence is not an eligibility claim. A nonce shows that a record went through the
signed-write path; the public read API omits signatures, so this service does not claim
cryptographic verification.