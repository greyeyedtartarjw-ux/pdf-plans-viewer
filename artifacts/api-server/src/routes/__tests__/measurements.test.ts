import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import app from "../../app.js";
import { db, documentsTable, measurementsTable } from "@workspace/db";
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

const sampleMeasurement = (id: string, documentId: number) => ({
  id,
  pageNumber: 1,
  type: "distance" as const,
  label: "Wall length",
  realWorldValue: 5.0,
  unit: "m",
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  fabricData: { type: "Line" },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/documents/:documentId/measurements — idempotent create", () => {
  let documentId: number;

  beforeEach(async () => {
    documentId = await createDocument();
  });

  afterEach(async () => {
    // Clean up the document (cascade deletes measurements)
    await db.delete(documentsTable).where(eq(documentsTable.id, documentId));
  });

  it("returns 201 and the new record on the first POST", async () => {
    const id = randomUUID();
    const body = sampleMeasurement(id, documentId);

    const res = await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(body)
      .expect(201);

    expect(res.body.id).toBe(id);
    expect(res.body.documentId).toBe(documentId);
    expect(res.body.label).toBe("Wall length");
  });

  it("returns 200 with the existing record on a duplicate POST (same id)", async () => {
    const id = randomUUID();
    const body = sampleMeasurement(id, documentId);

    // First request — should succeed with 201
    await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(body)
      .expect(201);

    // Second request with identical id — idempotent; must return 200
    const res = await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(body)
      .expect(200);

    expect(res.body.id).toBe(id);
    expect(res.body.documentId).toBe(documentId);
  });

  it("stores exactly one row after two POSTs with the same id", async () => {
    const id = randomUUID();
    const body = sampleMeasurement(id, documentId);

    await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(body);

    await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(body);

    const rows = await db
      .select()
      .from(measurementsTable)
      .where(eq(measurementsTable.id, id));

    expect(rows).toHaveLength(1);
  });
});
