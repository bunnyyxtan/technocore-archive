import app from "./app";
import { logger } from "./lib/logger";
import {
  startLiveEventBridge,
  stopLiveEventBridge,
} from "./live/events";
import { startLiveRecorder, stopLiveRecorder } from "./live/recorder";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void startLiveEventBridge().finally(() => {
    void startLiveRecorder();
  });
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down API and live recorder");
  server.close();
  await stopLiveRecorder();
  await stopLiveEventBridge();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
