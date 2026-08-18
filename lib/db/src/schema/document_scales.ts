import { boolean, integer, pgTable, real, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

export const documentScalesTable = pgTable("document_scales", {
  documentId: integer("document_id")
    .primaryKey()
    .references(() => documentsTable.id, { onDelete: "cascade" }),
  isSet: boolean("is_set").notNull().default(false),
  pixelsPerUnit: real("pixels_per_unit").notNull().default(1),
  unit: text("unit").notNull().default("px"),
  realWorldUnit: text("real_world_unit").notNull().default("px"),
});

export const insertDocumentScaleSchema = createInsertSchema(documentScalesTable);
export type InsertDocumentScale = z.infer<typeof insertDocumentScaleSchema>;
export type DocumentScale = typeof documentScalesTable.$inferSelect;
