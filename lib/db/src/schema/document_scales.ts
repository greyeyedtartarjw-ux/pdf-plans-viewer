import { boolean, integer, pgTable, primaryKey, real, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

export const documentScalesTable = pgTable("document_scales", {
  documentId: integer("document_id")
    .notNull()
    .references(() => documentsTable.id, { onDelete: "cascade" }),
  // A legacy document-wide scale becomes the page-one scale during schema push.
  pageNumber: integer("page_number").notNull().default(1),
  isSet: boolean("is_set").notNull().default(false),
  pixelsPerUnit: real("pixels_per_unit").notNull().default(1),
  unit: text("unit").notNull().default("px"),
  realWorldUnit: text("real_world_unit").notNull().default("ft"),
  scaleKind: text("scale_kind").notNull().default("custom"),
  presetRatio: text("preset_ratio"),
  calibrationDistanceFeet: real("calibration_distance_feet"),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.pageNumber] }),
]);

export const insertDocumentScaleSchema = createInsertSchema(documentScalesTable);
export type InsertDocumentScale = z.infer<typeof insertDocumentScaleSchema>;
export type DocumentScale = typeof documentScalesTable.$inferSelect;
