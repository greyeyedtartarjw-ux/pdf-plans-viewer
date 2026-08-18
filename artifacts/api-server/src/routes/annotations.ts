import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, annotationsTable } from "@workspace/db";
import {
  CreateAnnotationBody,
  CreateAnnotationParams,
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
  }).returning();

  res.status(201).json(CreateAnnotationResponse.parse({
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
