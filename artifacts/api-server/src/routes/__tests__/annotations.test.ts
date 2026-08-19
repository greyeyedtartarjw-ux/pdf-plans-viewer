import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import app from "../../app.js";
import { db, documentsTable, annotationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDocument(): Promise<number> {
  const res = await request(app)
    .post("/api/documents")
    .send({ name: "Test Plan", hash: randomUUID() })
    .expect(200);
  return res.body.id as number;
}

const sampleAnnotation = (id: string) => ({
  id,
  pageNumber: 1,
  type: "highlight" as const,
  fabricData: { type: "Rect", left: 10, top: 10, width: 100, height: 50 },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/documents/:documentId/annotations — idempotent create", () => {
  let documentId: number;

  beforeEach(async () => {
    documentId = await createDocument();
  });

  afterEach(async () => {
    // Clean up the document (cascade deletes annotations)
    await db.delete(documentsTable).where(eq(documentsTable.id, documentId));
  });

  it("returns 201 and the new record on the first POST", async () => {
    const id = randomUUID();
    const body = sampleAnnotation(id);

    const res = await request(app)
      .post(`/api/documents/${documentId}/annotations`)
      .send(body)
      .expect(201);

    expect(res.body.id).toBe(id);
    expect(res.body.documentId).toBe(documentId);
    expect(res.body.type).toBe("highlight");
  });

  it("returns 200 with the existing record on a duplicate POST (same id)", async () => {
    const id = randomUUID();
    const body = sampleAnnotation(id);

    // First request — should succeed with 201
    await request(app)
      .post(`/api/documents/${documentId}/annotations`)
      .send(body)
      .expect(201);

    // Second request with identical id — idempotent; must return 200
    const res = await request(app)
      .post(`/api/documents/${documentId}/annotations`)
      .send(body)
      .expect(200);

    expect(res.body.id).toBe(id);
    expect(res.body.documentId).toBe(documentId);
  });

  it("stores exactly one row after two POSTs with the same id", async () => {
    const id = randomUUID();
    const body = sampleAnnotation(id);

    await request(app)
      .post(`/api/documents/${documentId}/annotations`)
      .send(body);

    await request(app)
      .post(`/api/documents/${documentId}/annotations`)
      .send(body);

    const rows = await db
      .select()
      .from(annotationsTable)
      .where(eq(annotationsTable.id, id));

    expect(rows).toHaveLength(1);
  });
});
