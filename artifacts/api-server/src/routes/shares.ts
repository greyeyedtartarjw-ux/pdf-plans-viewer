import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, sharesTable, documentsTable, annotationsTable, measurementsTable, documentScalesTable } from "@workspace/db";
import {
  CreateShareBody,
  CreateShareResponse,
  GetShareParams,
  GetShareResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// POST /shares
router.post("/shares", async (req, res): Promise<void> => {
  const body = CreateShareBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  // Verify document exists
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, body.data.documentId));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const token = randomUUID();
  const [share] = await db.insert(sharesTable).values({
    documentId: body.data.documentId,
    token,
    expiresAt: null,
  }).returning();

  res.status(201).json(CreateShareResponse.parse({
    ...share,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
  }));
});

// GET /shares/:token
router.get("/shares/:token", async (req, res): Promise<void> => {
  const params = GetShareParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const [share] = await db.select().from(sharesTable).where(eq(sharesTable.token, params.data.token));
  if (!share) { res.status(404).json({ error: "Share not found" }); return; }

  // Check expiry
  if (share.expiresAt && share.expiresAt < new Date()) {
    res.status(404).json({ error: "Share has expired" }); return;
  }

  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, share.documentId));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const [scale] = await db.select().from(documentScalesTable).where(eq(documentScalesTable.documentId, doc.id));
  const annotations = await db.select().from(annotationsTable).where(eq(annotationsTable.documentId, doc.id));
  const measurements = await db.select().from(measurementsTable).where(eq(measurementsTable.documentId, doc.id));

  res.json(GetShareResponse.parse({
    document: { ...doc, createdAt: doc.createdAt.toISOString() },
    scale: scale
      ? { ...scale }
      : { documentId: doc.id, isSet: false, pixelsPerUnit: 1, unit: "px", realWorldUnit: "px" },
    annotations: annotations.map(a => ({
      ...a,
      fabricData: a.fabricData as Record<string, unknown>,
      createdAt: a.createdAt.toISOString(),
    })),
    measurements: measurements.map(m => ({
      ...m,
      points: m.points as Array<Record<string, unknown>>,
      fabricData: m.fabricData as Record<string, unknown>,
      createdAt: m.createdAt.toISOString(),
    })),
    share: {
      ...share,
      createdAt: share.createdAt.toISOString(),
      expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
    },
  }));
});

export default router;
