import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, measurementsTable } from "@workspace/db";
import {
  CreateMeasurementBody,
  CreateMeasurementParams,
  DeleteMeasurementParams,
  ListMeasurementsParams,
  ListMeasurementsResponse,
  CreateMeasurementResponse,
  UpdateMeasurementBody,
  UpdateMeasurementParams,
  UpdateMeasurementResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /documents/:documentId/measurements
router.get("/documents/:documentId/measurements", async (req, res): Promise<void> => {
  const params = ListMeasurementsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const rows = await db.select().from(measurementsTable)
    .where(eq(measurementsTable.documentId, params.data.documentId))
    .orderBy(measurementsTable.createdAt);

  res.json(ListMeasurementsResponse.parse(rows.map(r => ({
    ...r,
    points: r.points as Array<Record<string, unknown>>,
    fabricData: r.fabricData as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }))));
});

// POST /documents/:documentId/measurements
router.post("/documents/:documentId/measurements", async (req, res): Promise<void> => {
  const params = CreateMeasurementParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = CreateMeasurementBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [row] = await db.insert(measurementsTable).values({
    id: body.data.id,
    documentId: params.data.documentId,
    pageNumber: body.data.pageNumber,
    type: body.data.type,
    label: body.data.label,
    realWorldValue: body.data.realWorldValue,
    unit: body.data.unit,
    points: body.data.points,
    fabricData: body.data.fabricData,
  }).onConflictDoNothing().returning();

  // When the id already exists (e.g. a retried request whose first attempt
  // actually succeeded), the insert is a no-op and `row` is undefined.
  // Fetch the existing record so we can return it to the caller.
  if (!row) {
    const [existing] = await db.select().from(measurementsTable)
      .where(eq(measurementsTable.id, body.data.id));
    if (!existing) { res.status(409).json({ error: "Conflict" }); return; }
    res.status(200).json(CreateMeasurementResponse.parse({
      ...existing,
      points: existing.points as Array<Record<string, unknown>>,
      fabricData: existing.fabricData as Record<string, unknown>,
      createdAt: existing.createdAt.toISOString(),
    }));
    return;
  }

  res.status(201).json(CreateMeasurementResponse.parse({
    ...row,
    points: row.points as Array<Record<string, unknown>>,
    fabricData: row.fabricData as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
});

// PUT /documents/:documentId/measurements/:measurementId
router.put("/documents/:documentId/measurements/:measurementId", async (req, res): Promise<void> => {
  const params = UpdateMeasurementParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = UpdateMeasurementBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [row] = await db.update(measurementsTable)
    .set(body.data)
    .where(
      and(
        eq(measurementsTable.documentId, params.data.documentId),
        eq(measurementsTable.id, params.data.measurementId),
      ),
    )
    .returning();

  if (!row) { res.status(404).json({ error: "Measurement not found" }); return; }

  res.json(UpdateMeasurementResponse.parse({
    ...row,
    points: row.points as Array<Record<string, unknown>>,
    fabricData: row.fabricData as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
});

// DELETE /documents/:documentId/measurements/:measurementId
router.delete("/documents/:documentId/measurements/:measurementId", async (req, res): Promise<void> => {
  const params = DeleteMeasurementParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  await db.delete(measurementsTable).where(
    and(
      eq(measurementsTable.documentId, params.data.documentId),
      eq(measurementsTable.id, params.data.measurementId)
    )
  );
  res.sendStatus(204);
});

export default router;
