import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, documentsTable, documentScalesTable } from "@workspace/db";
import { normalizePageScale } from "../lib/pageScale";
import {
  UpsertDocumentBody,
  SetDocumentPageScaleBody,
  UpsertDocumentResponse,
  ListDocumentScalesResponse,
  SetDocumentPageScaleResponse,
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

function parsePositivePageNumber(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const pageNumber = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

const presetPixelsPerFoot = {
  "1/8": 9,
  "1/4": 18,
  "3/6": 36,
  "3/4": 54,
  "1": 72,
} as const;

// GET /documents/:documentId/scales
router.get("/documents/:documentId/scales", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.documentId) ? req.params.documentId[0] : req.params.documentId;
  const documentId = parseInt(raw, 10);
  if (isNaN(documentId)) { res.status(400).json({ error: "Invalid documentId" }); return; }

  const scales = await db
    .select()
    .from(documentScalesTable)
    .where(eq(documentScalesTable.documentId, documentId))
    .orderBy(documentScalesTable.pageNumber);
  res.json(ListDocumentScalesResponse.parse(scales.map(normalizePageScale)));
});

// PUT /documents/:documentId/scales/:pageNumber
router.put("/documents/:documentId/scales/:pageNumber", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.documentId) ? req.params.documentId[0] : req.params.documentId;
  const documentId = parseInt(raw, 10);
  if (isNaN(documentId)) { res.status(400).json({ error: "Invalid documentId" }); return; }
  const pageNumber = parsePositivePageNumber(req.params.pageNumber);
  if (!pageNumber) { res.status(400).json({ error: "Invalid pageNumber" }); return; }

  const parsed = SetDocumentPageScaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const isValidPreset = parsed.data.scaleKind === "preset"
    && parsed.data.presetRatio !== null
    && parsed.data.calibrationDistanceFeet === null
    && parsed.data.pixelsPerUnit === presetPixelsPerFoot[parsed.data.presetRatio];
  const isValidCustom = parsed.data.scaleKind === "custom"
    && parsed.data.presetRatio === null
    && parsed.data.calibrationDistanceFeet !== null
    && parsed.data.calibrationDistanceFeet > 0;
  if (
    !Number.isFinite(parsed.data.pixelsPerUnit)
    || parsed.data.pixelsPerUnit <= 0
    || parsed.data.unit !== "px"
    || parsed.data.realWorldUnit !== "ft"
    || (!isValidPreset && !isValidCustom)
  ) {
    res.status(400).json({ error: "Invalid feet-based page scale" });
    return;
  }

  const key = and(
    eq(documentScalesTable.documentId, documentId),
    eq(documentScalesTable.pageNumber, pageNumber),
  );
  const [existing] = await db.select().from(documentScalesTable).where(key);
  let scale;
  if (existing) {
    [scale] = await db.update(documentScalesTable).set(parsed.data).where(key).returning();
  } else {
    [scale] = await db.insert(documentScalesTable).values({ documentId, pageNumber, ...parsed.data }).returning();
  }
  res.json(SetDocumentPageScaleResponse.parse(scale));
});

export default router;
