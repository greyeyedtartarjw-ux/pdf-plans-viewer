import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, documentsTable, documentScalesTable } from "@workspace/db";
import {
  UpsertDocumentBody,
  SetDocumentScaleBody,
  UpsertDocumentResponse,
  GetDocumentScaleResponse,
  SetDocumentScaleResponse,
  ListDocumentsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /documents
router.get("/documents", async (_req, res): Promise<void> => {
  const docs = await db.select().from(documentsTable).orderBy(documentsTable.createdAt);
  res.json(ListDocumentsResponse.parse(docs.map(d => ({ ...d, createdAt: d.createdAt.toISOString() }))));
});

// POST /documents — upsert by hash
router.post("/documents", async (req, res): Promise<void> => {
  const parsed = UpsertDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await db.select().from(documentsTable).where(eq(documentsTable.hash, parsed.data.hash));
  if (existing.length > 0) {
    res.json(UpsertDocumentResponse.parse({ ...existing[0], createdAt: existing[0].createdAt.toISOString() }));
    return;
  }

  const [doc] = await db.insert(documentsTable).values(parsed.data).returning();
  res.json(UpsertDocumentResponse.parse({ ...doc, createdAt: doc.createdAt.toISOString() }));
});

// GET /documents/:documentId/scale
router.get("/documents/:documentId/scale", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.documentId) ? req.params.documentId[0] : req.params.documentId;
  const documentId = parseInt(raw, 10);
  if (isNaN(documentId)) { res.status(400).json({ error: "Invalid documentId" }); return; }

  const [scale] = await db.select().from(documentScalesTable).where(eq(documentScalesTable.documentId, documentId));
  if (!scale) {
    // Return default unset scale
    res.json(GetDocumentScaleResponse.parse({ documentId, isSet: false, pixelsPerUnit: 1, unit: "px", realWorldUnit: "px" }));
    return;
  }
  res.json(GetDocumentScaleResponse.parse({ ...scale }));
});

// PUT /documents/:documentId/scale
router.put("/documents/:documentId/scale", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.documentId) ? req.params.documentId[0] : req.params.documentId;
  const documentId = parseInt(raw, 10);
  if (isNaN(documentId)) { res.status(400).json({ error: "Invalid documentId" }); return; }

  const parsed = SetDocumentScaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select().from(documentScalesTable).where(eq(documentScalesTable.documentId, documentId));
  let scale;
  if (existing) {
    [scale] = await db.update(documentScalesTable).set(parsed.data).where(eq(documentScalesTable.documentId, documentId)).returning();
  } else {
    [scale] = await db.insert(documentScalesTable).values({ documentId, ...parsed.data }).returning();
  }
  res.json(SetDocumentScaleResponse.parse({ ...scale }));
});

export default router;
