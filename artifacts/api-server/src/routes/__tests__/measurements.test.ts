import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import app from "../../app.js";
import { db, documentsTable, documentScalesTable, measurementsTable } from "@workspace/db";
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
  valueLabel: "5.00 m",
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
    expect(res.body.valueLabel).toBe("5.00 m");
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

describe("PUT /api/documents/:documentId/measurements/:measurementId", () => {
  let documentId: number;

  beforeEach(async () => {
    documentId = await createDocument();
  });

  afterEach(async () => {
    await db.delete(documentsTable).where(eq(documentsTable.id, documentId));
  });

  it("updates recalculated values and the matching Fabric label", async () => {
    const id = randomUUID();
    await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(sampleMeasurement(id, documentId))
      .expect(201);

    const res = await request(app)
      .put(`/api/documents/${documentId}/measurements/${id}`)
      .send({
        label: "2.50 m",
        valueLabel: "2.50 m",
        realWorldValue: 2.5,
        unit: "m",
        fabricData: {
          type: "Group",
          objects: [{ type: "Text", text: "2.50 m" }],
        },
      })
      .expect(200);

    expect(res.body).toMatchObject({
      id,
      documentId,
      label: "2.50 m",
      valueLabel: "2.50 m",
      realWorldValue: 2.5,
      unit: "m",
      fabricData: {
        type: "Group",
        objects: [{ type: "Text", text: "2.50 m" }],
      },
      pageNumber: 1,
      type: "distance",
    });
  });

  it("persists a custom label separately from the generated value label", async () => {
    const id = randomUUID();
    await request(app)
      .post(`/api/documents/${documentId}/measurements`)
      .send(sampleMeasurement(id, documentId))
      .expect(201);

    await request(app)
      .put(`/api/documents/${documentId}/measurements/${id}`)
      .send({
        label: "North wall",
        valueLabel: "5.00 m",
        realWorldValue: 5,
        unit: "m",
        fabricData: { type: "Group" },
      })
      .expect(200);

    const listed = await request(app)
      .get(`/api/documents/${documentId}/measurements`)
      .expect(200);
    expect(listed.body[0]).toMatchObject({
      label: "North wall",
      valueLabel: "5.00 m",
    });
  });
});

describe("document page scales", () => {
  let documentId: number;

  beforeEach(async () => {
    documentId = await createDocument();
  });

  afterEach(async () => {
    await db.delete(documentsTable).where(eq(documentsTable.id, documentId));
  });

  const presetScale = {
    isSet: true,
    pixelsPerUnit: 18,
    unit: "px",
    realWorldUnit: "ft",
    scaleKind: "preset",
    presetRatio: "1/4",
    calibrationDistanceFeet: null,
  };

  it("stores isolated preset and custom scales by page and includes them in a share", async () => {
    await request(app)
      .put(`/api/documents/${documentId}/scales/1`)
      .send(presetScale)
      .expect(200);

    const custom = await request(app)
      .put(`/api/documents/${documentId}/scales/2`)
      .send({
        isSet: true,
        pixelsPerUnit: 24,
        unit: "px",
        realWorldUnit: "ft",
        scaleKind: "custom",
        presetRatio: null,
        calibrationDistanceFeet: 10,
      })
      .expect(200);
    expect(custom.body).toMatchObject({
      documentId,
      pageNumber: 2,
      scaleKind: "custom",
      calibrationDistanceFeet: 10,
    });

    const listed = await request(app)
      .get(`/api/documents/${documentId}/scales`)
      .expect(200);
    expect(listed.body).toMatchObject([
      { pageNumber: 1, pixelsPerUnit: 18, presetRatio: "1/4" },
      { pageNumber: 2, pixelsPerUnit: 24, scaleKind: "custom" },
    ]);

    const share = await request(app)
      .post("/api/shares")
      .send({ documentId })
      .expect(201);
    const payload = await request(app)
      .get(`/api/shares/${share.body.token}`)
      .expect(200);
    expect(payload.body.scales).toMatchObject([
      { pageNumber: 1, presetRatio: "1/4" },
      { pageNumber: 2, calibrationDistanceFeet: 10 },
    ]);
  });

  it("rejects invalid page numbers and non-feet scale inputs", async () => {
    await request(app)
      .put(`/api/documents/${documentId}/scales/0`)
      .send(presetScale)
      .expect(400);

    await request(app)
      .put(`/api/documents/${documentId}/scales/1`)
      .send({ ...presetScale, realWorldUnit: "m" })
      .expect(400);
  });

  it("enforces every canonical preset mapping and rejects conflicting metadata", async () => {
    const presets = [
      ["1/8", 9],
      ["1/4", 18],
      ["3/6", 36],
      ["3/4", 54],
      ["1", 72],
    ] as const;
    for (const [presetRatio, pixelsPerUnit] of presets) {
      await request(app)
        .put(`/api/documents/${documentId}/scales/${pixelsPerUnit}`)
        .send({ ...presetScale, presetRatio, pixelsPerUnit })
        .expect(200);
    }
    await request(app)
      .put(`/api/documents/${documentId}/scales/99`)
      .send({ ...presetScale, presetRatio: "1/8", pixelsPerUnit: 18 })
      .expect(400);
    await request(app)
      .put(`/api/documents/${documentId}/scales/100`)
      .send({ ...presetScale, calibrationDistanceFeet: 1 })
      .expect(400);
  });

  it("serves a legacy document-wide calibration as an equivalent page-one feet scale", async () => {
    await db.insert(documentScalesTable).values({
      documentId,
      pageNumber: 1,
      isSet: true,
      pixelsPerUnit: 10,
      unit: "px",
      realWorldUnit: "in",
      scaleKind: "custom",
      presetRatio: null,
      calibrationDistanceFeet: null,
    });

    const listed = await request(app)
      .get(`/api/documents/${documentId}/scales`)
      .expect(200);
    expect(listed.body).toMatchObject([{
      pageNumber: 1,
      pixelsPerUnit: 120,
      realWorldUnit: "ft",
      scaleKind: "custom",
      calibrationDistanceFeet: 1,
    }]);
  });
});
