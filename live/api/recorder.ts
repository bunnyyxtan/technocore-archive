import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  db,
  pool,
  technocoreRecordsTable,
  technocoreRoomStateTable,
  type LostRange,
} from "@workspace/db";
import { count, desc, eq, max, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { publishLiveCapture, type LiveCaptureEvent } from "./events";

const BASE = "https://technocore.chat";
const LIMIT = 200;
const TARGET_BATCH = 60;
const MIN_WAIT = 500;
const MAX_WAIT = 4_000;
const RECORDER_LOCK = 1_934_862_501;
const ROOMS = ["technocore", "lobby"] as const;
const ARCHIVE_DIR = [
  resolve(process.cwd(), "technocore-archive", "data"),
  resolve(process.cwd(), "..", "..", "technocore-archive", "data"),
].find((candidate) => existsSync(candidate));

type Room = (typeof ROOMS)[number];
type UpstreamRecord = {
  seq: number;
  from: string;
  nonce?: string;
  text: string;
  ts: string;
};
type UpstreamResponse = {
  messages?: unknown[];
  last_seq?: number;
};

const sleep = (ms: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

function isRoom(value: string): value is Room {
  return ROOMS.includes(value as Room);
}

function normalizeRecord(value: unknown): UpstreamRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const seq = Number(raw["seq"]);
  const from = raw["from"];
  const text = raw["text"];
  const ts = raw["ts"];
  const nonce = raw["nonce"];
  if (
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    typeof from !== "string" ||
    typeof text !== "string" ||
    typeof ts !== "string" ||
    Number.isNaN(Date.parse(ts))
  ) {
    return null;
  }
  return {
    seq,
    from,
    text,
    ts,
    ...(typeof nonce === "string" || typeof nonce === "number"
      ? { nonce: String(nonce) }
      : {}),
  };
}

async function insertRecords(
  room: Room,
  records: UpstreamRecord[],
) {
  if (!records.length) return [];
  return db
    .insert(technocoreRecordsTable)
    .values(
      records.map((record) => ({
        room,
        seq: record.seq,
        did: record.from,
        nonce: record.nonce ?? null,
        text: record.text,
        sourceTs: new Date(record.ts),
        capturedAt: new Date(),
      })),
    )
    .onConflictDoNothing()
    .returning({ seq: technocoreRecordsTable.seq });
}

async function seedRoomFromFile(room: Room): Promise<void> {
  if (!ARCHIVE_DIR) {
    logger.warn({ room }, "Archive seed directory is unavailable");
    return;
  }
  const path = resolve(ARCHIVE_DIR, `${room}.jsonl`);

  const statePath = resolve(ARCHIVE_DIR, `${room}.state.json`);
  let state: {
    cursor?: number;
    records?: number;
    lost?: LostRange[];
    firstCaptureAt?: string | null;
    lastCaptureAt?: string | null;
  } = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
    } catch (error) {
      logger.warn({ room, error }, "Could not read the archive seed state");
    }
  }

  const [[existing], [currentState]] = await Promise.all([
    db
      .select({
        count: count(),
        maxSeq: max(technocoreRecordsTable.seq),
      })
      .from(technocoreRecordsTable)
      .where(eq(technocoreRecordsTable.room, room)),
    db
      .select()
      .from(technocoreRoomStateTable)
      .where(eq(technocoreRoomStateTable.room, room))
      .limit(1),
  ]);
  const existingMax = existing?.maxSeq ?? 0;
  const expectedRecords = Number(state.records ?? 0);
  let imported = 0;
  let fileMax = Number(state.cursor ?? 0);
  if (
    (existing?.count ?? 0) < expectedRecords ||
    existingMax < fileMax ||
    (currentState?.seedVersion ?? 0) < 1
  ) {
    const input = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let batch: UpstreamRecord[] = [];
    for await (const line of input) {
      if (!line) continue;
      try {
        const record = normalizeRecord(JSON.parse(line));
        if (!record) continue;
        fileMax = Math.max(fileMax, record.seq);
        batch.push(record);
        if (batch.length >= 500) {
          imported += (await insertRecords(room, batch)).length;
          batch = [];
        }
      } catch {
        logger.warn({ room }, "Dropped an unparseable archive seed line");
      }
    }
    if (batch.length) {
      imported += (await insertRecords(room, batch)).length;
    }
  }

  const cursor = Math.max(existingMax, fileMax, Number(state.cursor ?? 0));

  if (!currentState || currentState.cursor <= cursor) {
    const firstCaptureAt = state.firstCaptureAt
      ? new Date(state.firstCaptureAt)
      : currentState?.firstCaptureAt ?? null;
    const lastCaptureAt = state.lastCaptureAt
      ? new Date(state.lastCaptureAt)
      : currentState?.lastCaptureAt ?? null;
    await db
      .insert(technocoreRoomStateTable)
      .values({
        room,
        cursor,
        seedVersion: 1,
        lostRanges: state.lost ?? currentState?.lostRanges ?? [],
        firstCaptureAt,
        lastCaptureAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: technocoreRoomStateTable.room,
        set: {
          seedVersion: 1,
          cursor: sql`greatest(${technocoreRoomStateTable.cursor}, ${cursor})`,
          updatedAt: new Date(),
        },
      });
  }

  logger.info(
    { room, imported, existingMax, fileMax, cursor },
    "Archive seed synchronized",
  );
}

async function readRoom(
  room: Room,
  since: number,
  tries = 6,
): Promise<UpstreamResponse> {
  const url = `${BASE}/r/${room}?format=json&since=${since}&limit=${LIMIT}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "on-the-record-live/1",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429) {
        const text = await response.text();
        const retrySeconds = Number(text.match(/\d+/)?.[0] ?? 5);
        await sleep(Math.min(retrySeconds, 30) * 1_000);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Technocore answered ${response.status}`);
      }
      return (await response.json()) as UpstreamResponse;
    } catch (error) {
      lastError = error;
      if (attempt < tries) await sleep(Math.min(attempt * 750, 4_000));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Technocore read failed");
}

class DatabaseRoomFollower {
  readonly room: Room;
  cursor = 0;
  lost: LostRange[] = [];
  firstCaptureAt: Date | null = null;
  lastCaptureAt: Date | null = null;
  rate = 0;
  lastPollAt = 0;

  constructor(room: Room) {
    this.room = room;
  }

  async load(): Promise<void> {
    const [recordHead] = await db
      .select({ maxSeq: max(technocoreRecordsTable.seq) })
      .from(technocoreRecordsTable)
      .where(eq(technocoreRecordsTable.room, this.room));
    const [state] = await db
      .select()
      .from(technocoreRoomStateTable)
      .where(eq(technocoreRoomStateTable.room, this.room))
      .limit(1);
    this.cursor = Math.max(recordHead?.maxSeq ?? 0, state?.cursor ?? 0);
    this.lost = state?.lostRanges ?? [];
    this.firstCaptureAt = state?.firstCaptureAt ?? null;
    this.lastCaptureAt = state?.lastCaptureAt ?? null;
    logger.info(
      { room: this.room, cursor: this.cursor },
      "Live recorder room loaded",
    );
  }

  noteLoss(from: number, to: number, reason: string): void {
    if (to < from) return;
    const last = this.lost.at(-1);
    if (last && last.reason === reason && from <= last.to + 1) {
      last.to = Math.max(last.to, to);
      return;
    }
    this.lost.push({
      from,
      to,
      reason,
      noticedAt: new Date().toISOString(),
    });
  }

  async flush(): Promise<void> {
    await db
      .insert(technocoreRoomStateTable)
      .values({
        room: this.room,
        cursor: this.cursor,
        lostRanges: this.lost,
        firstCaptureAt: this.firstCaptureAt,
        lastCaptureAt: this.lastCaptureAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: technocoreRoomStateTable.room,
        set: {
          cursor: this.cursor,
          lostRanges: this.lost,
          firstCaptureAt: this.firstCaptureAt,
          lastCaptureAt: this.lastCaptureAt,
          updatedAt: new Date(),
        },
      });
  }

  async step(): Promise<number> {
    const body = await readRoom(this.room, this.cursor);
    const messages = (body.messages ?? [])
      .map(normalizeRecord)
      .filter((record): record is UpstreamRecord => Boolean(record))
      .sort((left, right) => left.seq - right.seq);

    if (!messages.length) {
      const head = Number(body.last_seq ?? this.cursor);
      if (head > this.cursor) {
        this.noteLoss(
          this.cursor + 1,
          head,
          "server reported newer records it would not serve from this cursor",
        );
        await this.flush();
      }
      return 2_000;
    }

    const first = messages[0]!.seq;
    const last = messages.at(-1)!.seq;
    if (first > this.cursor + 1) {
      this.noteLoss(
        this.cursor + 1,
        first - 1,
        "evicted from the ring before capture reached it",
      );
    }
    for (let index = 1; index < messages.length; index += 1) {
      const previous = messages[index - 1]!.seq;
      const current = messages[index]!.seq;
      if (current > previous + 1) {
        this.noteLoss(
          previous + 1,
          current - 1,
          "absent from a response that spanned it",
        );
      }
    }

    const inserted = await insertRecords(this.room, messages);
    this.cursor = Math.max(this.cursor, last);
    let captureEvent: LiveCaptureEvent | null = null;
    if (inserted.length) {
      const capturedAt = new Date();
      this.firstCaptureAt ??= capturedAt;
      this.lastCaptureAt = capturedAt;
      captureEvent = {
        room: this.room,
        maxSeq: this.cursor,
        inserted: inserted.length,
        capturedAt: capturedAt.toISOString(),
      };
    }
    await this.flush();
    if (captureEvent) await publishLiveCapture(captureEvent);

    const at = Date.now();
    if (this.lastPollAt) {
      const elapsed = (at - this.lastPollAt) / 1_000;
      if (elapsed >= 0.2) {
        const observed = messages.length / elapsed;
        this.rate = this.rate
          ? this.rate * 0.7 + observed * 0.3
          : observed;
      }
    }
    this.lastPollAt = at;
    if (messages.length >= LIMIT) {
      this.rate = Math.max(this.rate, LIMIT);
      return 0;
    }
    const wait = this.rate > 0 ? (TARGET_BATCH / this.rate) * 1_000 : 2_000;
    return Math.max(MIN_WAIT, Math.min(MAX_WAIT, wait));
  }

  async follow(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait = 1_500;
      try {
        wait = await this.step();
      } catch (error) {
        logger.error({ room: this.room, error }, "Live recorder read failed");
        wait = 3_000;
      }
      if (wait && !signal.aborted) await sleep(wait);
    }
    await this.flush();
  }
}

let recorderMode: "starting" | "live" | "stale" = "starting";
let abortController: AbortController | null = null;
let runner: Promise<void> | null = null;
let releaseLock: (() => Promise<void>) | null = null;

export function getLiveRecorderMode(): "starting" | "live" | "stale" {
  return recorderMode;
}

export async function startLiveRecorder(): Promise<void> {
  if (runner) return runner;
  abortController = new AbortController();
  const signal = abortController.signal;
  runner = (async () => {
    const client = await pool.connect();
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [RECORDER_LOCK],
    );
    if (!lockResult.rows[0]?.locked) {
      client.release();
      recorderMode = "stale";
      logger.warn(
        "Another API process owns the live recorder lock; serving its database",
      );
      return;
    }
    releaseLock = async () => {
      await client.query("SELECT pg_advisory_unlock($1)", [RECORDER_LOCK]);
      client.release();
    };

    const followers = ROOMS.map((room) => new DatabaseRoomFollower(room));
    await Promise.all(followers.map((follower) => follower.load()));
    recorderMode = "live";
    logger.info("Live database recorder started");
    const seed = Promise.all(ROOMS.map(seedRoomFromFile)).catch((error) => {
      logger.error(
        { error },
        "Archive seed failed; live recorder remains active",
      );
    });
    await Promise.all([
      Promise.all(followers.map((follower) => follower.follow(signal))),
      seed,
    ]);
  })()
    .catch((error) => {
      recorderMode = "stale";
      logger.error({ error }, "Live database recorder stopped unexpectedly");
    })
    .finally(() => {
      runner = null;
    });
  return runner;
}

export async function stopLiveRecorder(): Promise<void> {
  abortController?.abort();
  await runner;
  if (releaseLock) {
    await releaseLock();
    releaseLock = null;
  }
  recorderMode = "stale";
}

export async function latestDatabaseSequence(room: Room): Promise<number> {
  if (!isRoom(room)) return 0;
  const [row] = await db
    .select({ seq: technocoreRecordsTable.seq })
    .from(technocoreRecordsTable)
    .where(eq(technocoreRecordsTable.room, room))
    .orderBy(desc(technocoreRecordsTable.seq))
    .limit(1);
  return row?.seq ?? 0;
}