import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, annotationsTable } from "@workspace/db";
import {
  CreateAnnotationBody,
  CreateAnnotationParams,
  UpdateAnnotationBody,
  UpdateAnnotationParams,
  UpdateAnnotationResponse,
  DeleteAnnotationParams,
  ListAnnotationsParams,
  ListAnnotationsResponse,
  CreateAnnotationResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /documents/:documentId/annotations
router.get("/documents/:documentId/annotations", async (req, res): Promise<void> => {
  const params = ListAnnotationsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const rows = await db.select().from(annotationsTable)
    .where(eq(annotationsTable.documentId, params.data.documentId))
    .orderBy(annotationsTable.createdAt);

  res.json(ListAnnotationsResponse.parse(rows.map(r => ({
    ...r,
    fabricData: r.fabricData as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }))));
});

// POST /documents/:documentId/annotations
router.post("/documents/:documentId/annotations", async (req, res): Promise<void> => {
  const params = CreateAnnotationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = CreateAnnotationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [row] = await db.insert(annotationsTable).values({
    id: body.data.id,
    documentId: params.data.documentId,
    pageNumber: body.data.pageNumber,
    type: body.data.type,
    fabricData: body.data.fabricData,
  }).onConflictDoNothing().returning();

  // When the id already exists (e.g. a retried request whose first attempt
  // actually succeeded), the insert is a no-op and `row` is undefined.
  // Fetch the existing record so we can return it to the caller.
  if (!row) {
    const [existing] = await db.select().from(annotationsTable)
      .where(eq(annotationsTable.id, body.data.id));
    if (!existing) { res.status(409).json({ error: "Conflict" }); return; }
    res.status(200).json(CreateAnnotationResponse.parse({
      ...existing,
      fabricData: existing.fabricData as Record<string, unknown>,
      createdAt: existing.createdAt.toISOString(),
    }));
    return;
  }

  res.status(201).json(CreateAnnotationResponse.parse({
    ...row,
    fabricData: row.fabricData as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
});

// PUT /documents/:documentId/annotations/:annotationId
router.put("/documents/:documentId/annotations/:annotationId", async (req, res): Promise<void> => {
  const params = UpdateAnnotationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = UpdateAnnotationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [row] = await db.update(annotationsTable)
    .set({ fabricData: body.data.fabricData })
    .where(and(
      eq(annotationsTable.documentId, params.data.documentId),
      eq(annotationsTable.id, params.data.annotationId),
    ))
    .returning();

  if (!row) { res.status(404).json({ error: "Annotation not found" }); return; }
  res.json(UpdateAnnotationResponse.parse({
    ...row,
    fabricData: row.fabricData as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
});

// DELETE /documents/:documentId/annotations/:annotationId
router.delete("/documents/:documentId/annotations/:annotationId", async (req, res): Promise<void> => {
  const params = DeleteAnnotationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  await db.delete(annotationsTable).where(
    and(
      eq(annotationsTable.documentId, params.data.documentId),
      eq(annotationsTable.id, params.data.annotationId)
    )
  );
  res.sendStatus(204);
});

export default router;
