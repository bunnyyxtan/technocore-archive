import {
  bigint,
  index,
  jsonb,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type LostRange = {
  from: number;
  to: number;
  reason: string;
  noticedAt: string;
};

export const technocoreRecordsTable = pgTable(
  "technocore_records",
  {
    room: text("room").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    did: text("did").notNull(),
    nonce: text("nonce"),
    text: text("text").notNull(),
    sourceTs: timestamp("source_ts", { withTimezone: true }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.room, table.seq] }),
    index("technocore_records_did_idx").on(table.did),
    index("technocore_records_source_ts_idx").on(table.sourceTs),
  ],
);

export const technocoreRoomStateTable = pgTable("technocore_room_state", {
  room: text("room").primaryKey(),
  cursor: bigint("cursor", { mode: "number" }).notNull().default(0),
  seedVersion: integer("seed_version").notNull().default(0),
  lostRanges: jsonb("lost_ranges")
    .$type<LostRange[]>()
    .notNull()
    .default([]),
  firstCaptureAt: timestamp("first_capture_at", { withTimezone: true }),
  lastCaptureAt: timestamp("last_capture_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTechnocoreRecordSchema = createInsertSchema(
  technocoreRecordsTable,
).omit({ capturedAt: true });
export const insertTechnocoreRoomStateSchema = createInsertSchema(
  technocoreRoomStateTable,
).omit({ updatedAt: true });

export type InsertTechnocoreRecord = z.infer<
  typeof insertTechnocoreRecordSchema
>;
export type TechnocoreRecord = typeof technocoreRecordsTable.$inferSelect;
export type InsertTechnocoreRoomState = z.infer<
  typeof insertTechnocoreRoomStateSchema
>;
export type TechnocoreRoomState =
  typeof technocoreRoomStateTable.$inferSelect;