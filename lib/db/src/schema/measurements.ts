import { integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

export const measurementsTable = pgTable("measurements", {
  id: text("id").primaryKey(), // UUID supplied by the client
  documentId: integer("document_id")
    .notNull()
    .references(() => documentsTable.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  type: text("type", { enum: ["distance", "area"] }).notNull(),
  label: text("label").notNull(),
  realWorldValue: real("real_world_value").notNull(),
  unit: text("unit").notNull(),
  points: jsonb("points").notNull(),
  fabricData: jsonb("fabric_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMeasurementSchema = createInsertSchema(measurementsTable).omit({ createdAt: true });
export type InsertMeasurement = z.infer<typeof insertMeasurementSchema>;
export type Measurement = typeof measurementsTable.$inferSelect;
