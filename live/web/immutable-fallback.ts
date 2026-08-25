import snapshotRaw from '../../../../technocore-archive/latest.json?raw';

type SnapshotRecord = {
  from: string;
  nonce?: string | number;
  seq: number;
  text: string;
  ts: string;
};

type Snapshot = {
  fetchedAt?: string;
  messages?: SnapshotRecord[];
};

export type ImmutableDidResult = {
  did: string;
  found: true;
  count: number;
  firstTs: string;
  lastTs: string;
  signedPathCount: number;
  rooms: Record<string, number>;
  seqs: number[];
  records: Array<{
    room: 'technocore';
    seq: number;
    from: string;
    nonce: string | null;
    text: string;
    ts: string;
  }>;
  recordsShown: number;
  source: 'immutable';
  generatedAt: string;
};

const snapshot = JSON.parse(snapshotRaw) as Snapshot;
const immutableRecords = snapshot.messages ?? [];

export function lookupImmutableDid(did: string): ImmutableDidResult | null {
  const matches = immutableRecords
    .filter((record) => record.from === did)
    .sort((left, right) => left.seq - right.seq);
  if (!matches.length) return null;

  const bounded = new Map<number, SnapshotRecord>();
  for (const record of [...matches.slice(0, 3), ...matches.slice(-3)]) {
    bounded.set(record.seq, record);
  }
  const records = [...bounded.values()]
    .sort((left, right) => left.seq - right.seq)
    .map((record) => ({
      room: 'technocore' as const,
      seq: record.seq,
      from: record.from,
      nonce:
        record.nonce === undefined || record.nonce === null
          ? null
          : String(record.nonce),
      text: record.text,
      ts: record.ts,
    }));

  return {
    did,
    found: true,
    count: matches.length,
    firstTs: matches[0]!.ts,
    lastTs: matches.at(-1)!.ts,
    signedPathCount: matches.filter(
      (record) => record.nonce !== undefined && record.nonce !== null,
    ).length,
    rooms: { technocore: matches.length },
    seqs: matches.map((record) => record.seq),
    records,
    recordsShown: records.length,
    source: 'immutable',
    generatedAt: snapshot.fetchedAt ?? matches.at(-1)!.ts,
  };
}