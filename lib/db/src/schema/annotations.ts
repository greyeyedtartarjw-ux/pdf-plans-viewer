import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

export const annotationsTable = pgTable("annotations", {
  id: text("id").primaryKey(), // UUID supplied by the client
  documentId: integer("document_id")
    .notNull()
    .references(() => documentsTable.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  type: text("type", { enum: ["highlight", "note", "text"] }).notNull(),
  fabricData: jsonb("fabric_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAnnotationSchema = createInsertSchema(annotationsTable).omit({ createdAt: true });
export type InsertAnnotation = z.infer<typeof insertAnnotationSchema>;
export type Annotation = typeof annotationsTable.$inferSelect;
