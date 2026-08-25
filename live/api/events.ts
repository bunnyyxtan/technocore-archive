import { EventEmitter } from "node:events";
import { pool, type PoolClient } from "@workspace/db";
import { logger } from "../lib/logger";

export type LiveCaptureEvent = {
  room: "technocore" | "lobby";
  maxSeq: number;
  inserted: number;
  capturedAt: string;
};

export const liveCaptureEvents = new EventEmitter();
liveCaptureEvents.setMaxListeners(500);

const CAPTURE_CHANNEL = "technocore_capture";
let listener: PoolClient | null = null;
let starting: Promise<void> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;

function isLiveCaptureEvent(value: unknown): value is LiveCaptureEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<LiveCaptureEvent>;
  return (
    (event.room === "technocore" || event.room === "lobby") &&
    Number.isSafeInteger(event.maxSeq) &&
    Number.isSafeInteger(event.inserted) &&
    typeof event.capturedAt === "string"
  );
}

function scheduleReconnect(): void {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startLiveEventBridge();
  }, 1_000);
}

async function connectListener(): Promise<void> {
  const client = await pool.connect();
  listener = client;
  const loseConnection = (error?: Error) => {
    if (listener !== client) return;
    listener = null;
    try {
      client.release(error ?? true);
    } catch {
      // The pool may already have removed a failed client.
    }
    if (error) {
      logger.error({ error }, "Live event bridge connection failed");
    }
    scheduleReconnect();
  };
  client.on("error", loseConnection);
  client.on("end", () => loseConnection());
  client.on("notification", (message) => {
    if (message.channel !== CAPTURE_CHANNEL || !message.payload) return;
    try {
      const event: unknown = JSON.parse(message.payload);
      if (isLiveCaptureEvent(event)) {
        liveCaptureEvents.emit("capture", event);
      }
    } catch (error) {
      logger.warn({ error }, "Ignored a malformed live capture notification");
    }
  });
  try {
    await client.query(`LISTEN ${CAPTURE_CHANNEL}`);
  } catch (error) {
    loseConnection(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  logger.info("PostgreSQL live event bridge started");
}

export function startLiveEventBridge(): Promise<void> {
  if (listener) return Promise.resolve();
  if (starting) return starting;
  stopping = false;
  starting = connectListener()
    .catch((error) => {
      logger.error({ error }, "Could not start the live event bridge");
      scheduleReconnect();
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

export async function publishLiveCapture(
  event: LiveCaptureEvent,
): Promise<void> {
  await pool.query(
    `SELECT pg_notify('${CAPTURE_CHANNEL}', $1)`,
    [JSON.stringify(event)],
  );
}

export async function stopLiveEventBridge(): Promise<void> {
  stopping = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  await starting;
  const client = listener;
  listener = null;
  if (!client) return;
  try {
    await client.query(`UNLISTEN ${CAPTURE_CHANNEL}`);
  } finally {
    client.release();
  }
}