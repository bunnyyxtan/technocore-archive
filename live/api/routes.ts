import { Router, type IRouter } from "express";
import {
  GetLiveArchiveStatusResponse,
  GetLiveDidParams,
  GetLiveDidResponse,
  GetLiveRecentRecordsQueryParams,
  GetLiveRecentRecordsResponse,
} from "@workspace/api-zod";
import {
  db,
  technocoreRecordsTable,
  technocoreRoomStateTable,
  type TechnocoreRecord,
} from "@workspace/db";
import {
  count,
  countDistinct,
  desc,
  eq,
  max,
  min,
  sql,
} from "drizzle-orm";
import { liveCaptureEvents, type LiveCaptureEvent } from "../live/events";

const router: IRouter = Router();
const ROOMS = ["technocore", "lobby"] as const;
type Room = (typeof ROOMS)[number];

function toPublicRecord(record: TechnocoreRecord) {
  if (!ROOMS.includes(record.room as Room)) {
    throw new Error(`Unexpected room in live archive: ${record.room}`);
  }
  return {
    room: record.room as Room,
    seq: record.seq,
    from: record.did,
    nonce: record.nonce,
    text: record.text,
    ts: record.sourceTs,
  };
}

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  next();
});

router.get("/live/status", async (_req, res): Promise<void> => {
  const [recordTotals, uniqueTotals, states] = await Promise.all([
    db
      .select({
        room: technocoreRecordsTable.room,
        recordsHeld: count(),
        maxSeq: max(technocoreRecordsTable.seq),
        firstSeq: min(technocoreRecordsTable.seq),
      })
      .from(technocoreRecordsTable)
      .groupBy(technocoreRecordsTable.room),
    db
      .select({ uniqueDids: countDistinct(technocoreRecordsTable.did) })
      .from(technocoreRecordsTable),
    db.select().from(technocoreRoomStateTable),
  ]);

  const totalsByRoom = new Map(recordTotals.map((row) => [row.room, row]));
  const statesByRoom = new Map(states.map((row) => [row.room, row]));
  const now = new Date();
  const rooms = ROOMS.map((room) => {
    const totals = totalsByRoom.get(room);
    const state = statesByRoom.get(room);
    const lastCaptureAt = state?.lastCaptureAt ?? null;
    const lagSeconds = lastCaptureAt
      ? Math.max(0, (now.getTime() - lastCaptureAt.getTime()) / 1_000)
      : null;
    const maxSeq = totals?.maxSeq ?? 0;
    const recordsHeld = totals?.recordsHeld ?? 0;
    return {
      room,
      recordsHeld,
      maxSeq,
      firstSeq: totals?.firstSeq ?? 0,
      lastCaptureAt,
      lostRecords: Math.max(0, maxSeq - recordsHeld),
      lagSeconds,
    };
  });
  const finiteLags = rooms
    .map((room) => room.lagSeconds)
    .filter((lag): lag is number => lag !== null);
  const worstLag = finiteLags.length ? Math.max(...finiteLags) : null;
  const recorder =
    worstLag === null
      ? "starting"
      : worstLag < 45
        ? "live"
        : "stale";

  const payload = GetLiveArchiveStatusResponse.parse({
    source: "live",
    generatedAt: now,
    recorder,
    recordsHeld: rooms.reduce((sum, room) => sum + room.recordsHeld, 0),
    uniqueDids: uniqueTotals[0]?.uniqueDids ?? 0,
    rooms,
  });
  res.json(payload);
});

router.get("/live/dids/:did", async (req, res): Promise<void> => {
  const rawDid = Array.isArray(req.params["did"])
    ? req.params["did"][0]
    : req.params["did"];
  const params = GetLiveDidParams.safeParse({ did: rawDid });
  if (!params.success || !params.data.did.startsWith("did:key:z")) {
    res.status(400).json({ error: "Enter a valid did:key identifier" });
    return;
  }
  const did = params.data.did;
  const [summary] = await db
    .select({
      count: sql<number>`count(*)::int`,
      firstTs: min(technocoreRecordsTable.sourceTs),
      lastTs: max(technocoreRecordsTable.sourceTs),
      signedPathCount: sql<number>`count(${technocoreRecordsTable.nonce})::int`,
    })
    .from(technocoreRecordsTable)
    .where(eq(technocoreRecordsTable.did, did));

  const found = (summary?.count ?? 0) > 0;
  if (!found) {
    res.json(
      GetLiveDidResponse.parse({
        did,
        found: false,
        count: 0,
        firstTs: null,
        lastTs: null,
        signedPathCount: 0,
        rooms: {},
        seqs: [],
        records: [],
        recordsShown: 0,
        source: "live",
        generatedAt: new Date(),
      }),
    );
    return;
  }

  const [roomCounts, sequenceRows, firstRows, lastRows] = await Promise.all([
    db
      .select({
        room: technocoreRecordsTable.room,
        count: sql<number>`count(*)::int`,
      })
      .from(technocoreRecordsTable)
      .where(eq(technocoreRecordsTable.did, did))
      .groupBy(technocoreRecordsTable.room),
    db
      .select({ seq: technocoreRecordsTable.seq })
      .from(technocoreRecordsTable)
      .where(eq(technocoreRecordsTable.did, did))
      .orderBy(technocoreRecordsTable.seq)
      .limit(200),
    db
      .select()
      .from(technocoreRecordsTable)
      .where(eq(technocoreRecordsTable.did, did))
      .orderBy(technocoreRecordsTable.sourceTs, technocoreRecordsTable.seq)
      .limit(3),
    db
      .select()
      .from(technocoreRecordsTable)
      .where(eq(technocoreRecordsTable.did, did))
      .orderBy(
        desc(technocoreRecordsTable.sourceTs),
        desc(technocoreRecordsTable.seq),
      )
      .limit(3),
  ]);

  const evidence = new Map<string, TechnocoreRecord>();
  for (const record of [...firstRows, ...lastRows]) {
    evidence.set(`${record.room}:${record.seq}`, record);
  }
  const records = [...evidence.values()]
    .sort(
      (left, right) =>
        left.sourceTs.getTime() - right.sourceTs.getTime() ||
        left.seq - right.seq,
    )
    .map(toPublicRecord);
  const rooms = Object.fromEntries(
    roomCounts.map((row) => [row.room, row.count]),
  );

  res.json(
    GetLiveDidResponse.parse({
      did,
      found: true,
      count: summary!.count,
      firstTs: summary!.firstTs,
      lastTs: summary!.lastTs,
      signedPathCount: summary!.signedPathCount,
      rooms,
      seqs: sequenceRows.map((row) => row.seq),
      records,
      recordsShown: records.length,
      source: "live",
      generatedAt: new Date(),
    }),
  );
});

router.get("/live/recent", async (req, res): Promise<void> => {
  const params = GetLiveRecentRecordsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = params.data.room
    ? await db
        .select()
        .from(technocoreRecordsTable)
        .where(eq(technocoreRecordsTable.room, params.data.room))
        .orderBy(
          desc(technocoreRecordsTable.sourceTs),
          desc(technocoreRecordsTable.seq),
        )
        .limit(params.data.limit)
    : await db
        .select()
        .from(technocoreRecordsTable)
        .orderBy(
          desc(technocoreRecordsTable.sourceTs),
          desc(technocoreRecordsTable.seq),
        )
        .limit(params.data.limit);

  res.json(
    GetLiveRecentRecordsResponse.parse({
      generatedAt: new Date(),
      records: rows.map(toPublicRecord),
    }),
  );
});

router.get("/live/events", (req, res): void => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const onCapture = (event: LiveCaptureEvent) => {
    res.write(`id: ${event.room}:${event.maxSeq}\n`);
    res.write(`event: capture\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  liveCaptureEvents.on("capture", onCapture);

  req.on("close", () => {
    clearInterval(heartbeat);
    liveCaptureEvents.off("capture", onCapture);
  });
});

export default router;