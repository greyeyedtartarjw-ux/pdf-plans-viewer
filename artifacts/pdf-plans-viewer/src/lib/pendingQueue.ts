/**
 * Persistent queue for annotation/measurement operations that failed to reach
 * the server (e.g. due to connectivity loss). Backed by localStorage so that
 * the queue survives a page reload.
 *
 * Key design choices:
 * - Operations receive a monotonic sequence when the user initiates a save.
 *   They are replayed by that sequence rather than by the later order in which
 *   network requests happen to fail, preserving causal order (create → delete).
 *   A delete is NEVER cancelled by a pending create, because the create may
 *   have already committed on the server before its response was lost.
 * - Duplicate (id + opType) entries are collapsed to prevent double-sending the
 *   exact same request, but cross-type pairs (create + delete for the same id)
 *   are always preserved.
 * - After any mutation a custom DOM event is dispatched so listening components
 *   can update their displayed count without polling.
 * - Failures in localStorage access are silently swallowed — queue is best-effort.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingAnnotationCreate {
  opType: 'create_annotation';
  documentId: number;
  id: string;
  pageNumber: number;
  type: string;
  fabricData: Record<string, unknown>;
  timestamp: number;
  sequence: number;
}

export interface PendingAnnotationDelete {
  opType: 'delete_annotation';
  documentId: number;
  id: string;
  timestamp: number;
  sequence: number;
}

export interface PendingMeasurementCreate {
  opType: 'create_measurement';
  documentId: number;
  id: string;
  pageNumber: number;
  type: string;
  label: string;
  realWorldValue: number;
  unit: string;
  points: { x: number; y: number }[];
  fabricData: Record<string, unknown>;
  timestamp: number;
  sequence: number;
}

export interface PendingMeasurementDelete {
  opType: 'delete_measurement';
  documentId: number;
  id: string;
  timestamp: number;
  sequence: number;
}

export interface PendingMeasurementUpdate {
  opType: 'update_measurement';
  documentId: number;
  id: string;
  pageNumber: number;
  label: string;
  realWorldValue: number;
  unit: string;
  fabricData: Record<string, unknown>;
  timestamp: number;
  sequence: number;
}

export interface PendingScaleUpdate {
  opType: 'set_scale';
  documentId: number;
  /** One scale record exists per document, so repeated calibrations replace it. */
  id: 'scale';
  isSet: boolean;
  pixelsPerUnit: number;
  unit: string;
  realWorldUnit: string;
  timestamp: number;
  sequence: number;
}

export type PendingOp =
  | PendingAnnotationCreate
  | PendingAnnotationDelete
  | PendingMeasurementCreate
  | PendingMeasurementDelete
  | PendingMeasurementUpdate
  | PendingScaleUpdate;

let lastSequence = 0;

/**
 * Allocate a browser-session monotonic sequence at the moment the user starts
 * an operation. The Date.now()-derived base keeps sequences chronological even
 * across a reload; the in-memory increment breaks same-millisecond ties.
 */
export function nextPendingSequence(): number {
  lastSequence = Math.max(Date.now() * 1_000, lastSequence + 1);
  return lastSequence;
}

/** Compare queued operations by user-action order, including legacy entries. */
export function comparePendingOps(left: PendingOp, right: PendingOp): number {
  const leftSequence = typeof left.sequence === 'number' ? left.sequence : left.timestamp * 1_000;
  const rightSequence = typeof right.sequence === 'number' ? right.sequence : right.timestamp * 1_000;
  return leftSequence - rightSequence;
}

// ─── Cross-component notification ─────────────────────────────────────────────
// Any component can listen for this event to update a displayed pending count.
export const QUEUE_CHANGED_EVENT = 'pdf-plans-pending-queue-changed';

function dispatchQueueChanged(documentId: number, count: number): void {
  try {
    window.dispatchEvent(
      new CustomEvent(QUEUE_CHANGED_EVENT, { detail: { documentId, count } })
    );
  } catch {
    // Not in a browser context — ignore (e.g. SSR or test env)
  }
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageKey(documentId: number) {
  return `pdf-plans-pending-ops-${documentId}`;
}

function documentIdentityKey(hash: string) {
  return `pdf-plans-document-id-${hash}`;
}

/**
 * Cache the server document ID against the stable local PDF hash. This lets the
 * viewer find a document's pending queue even when it is reopened offline.
 */
export function setCachedDocumentId(hash: string, documentId: number): void {
  try {
    localStorage.setItem(documentIdentityKey(hash), String(documentId));
  } catch {
    // localStorage unavailable — the normal online loader remains available.
  }
}

/** Return the cached server document ID for a locally reopened PDF, if known. */
export function getCachedDocumentId(hash: string): number | null {
  try {
    const value = Number(localStorage.getItem(documentIdentityKey(hash)));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Remove an obsolete local document-ID mapping without touching its queue. */
export function removeCachedDocumentId(hash: string): void {
  try {
    localStorage.removeItem(documentIdentityKey(hash));
  } catch {
    // Storage can be unavailable in private browsing; queue persistence is
    // already best-effort in that environment.
  }
}

export function getPendingOps(documentId: number): PendingOp[] {
  try {
    const raw = localStorage.getItem(storageKey(documentId));
    if (!raw) return [];
    return (JSON.parse(raw) as PendingOp[]).sort(comparePendingOps);
  } catch {
    return [];
  }
}

/** The latest local calibration overrides a stale server scale after reload. */
export function getPendingScaleUpdate(documentId: number): PendingScaleUpdate | undefined {
  return getPendingOps(documentId)
    .filter((op): op is PendingScaleUpdate => op.opType === 'set_scale')
    .at(-1);
}

function setPendingOps(documentId: number, ops: PendingOp[]): void {
  try {
    if (ops.length === 0) {
      localStorage.removeItem(storageKey(documentId));
    } else {
      localStorage.setItem(storageKey(documentId), JSON.stringify(ops));
    }
  } catch {
    // localStorage quota exceeded or not available — fail silently
  }
}

/**
 * Add an operation to the persistent queue.
 *
 * Deduplication: if an identical op (same id + opType) is already queued, the
 * existing entry is replaced so we don't retry the same request twice. The
 * resulting queue is sorted by its user-action sequence, not failure timing.
 *
 * Cross-type pairs (create + delete for the same id) are intentionally kept
 * in order. A delete must NOT be dropped because a create is pending: the
 * create may have already committed on the server despite the client receiving
 * a transport error, so the delete is necessary to reflect the user's intent.
 */
export function addPendingOp(op: PendingOp): void {
  const ops = getPendingOps(op.documentId);
  // Replace an exact duplicate (same id + opType) to avoid double-sending.
  const filtered = ops.filter(o => !(o.id === op.id && o.opType === op.opType));
  const ordered = [...filtered, op].sort(comparePendingOps);
  setPendingOps(op.documentId, ordered);
  dispatchQueueChanged(op.documentId, ordered.length);
}

/** Remove a single operation after it has been successfully flushed. */
export function removePendingOp(documentId: number, id: string, opType: PendingOp['opType']): void {
  const ops = getPendingOps(documentId);
  const filtered = ops.filter(o => !(o.id === id && o.opType === opType));
  setPendingOps(documentId, filtered);
  dispatchQueueChanged(documentId, filtered.length);
}

/**
 * Flush queued operations in the exact order they were created.
 *
 * A failed operation stops the flush so dependent operations (such as a delete
 * immediately after a create) cannot overtake it. `isAlreadyApplied` lets the
 * caller recognise idempotent HTTP outcomes, such as a duplicate create after
 * the server committed the original request but its response was lost.
 */
export async function flushPendingOps(
  documentId: number,
  execute: (op: PendingOp) => Promise<void>,
  isAlreadyApplied: (op: PendingOp, error: unknown) => boolean,
): Promise<{ succeeded: number; failed: boolean; remaining: number }> {
  let succeeded = 0;
  let failed = false;

  for (const op of getPendingOps(documentId)) {
    try {
      await execute(op);
    } catch (error) {
      if (!isAlreadyApplied(op, error)) {
        failed = true;
        break;
      }
    }

    removePendingOp(op.documentId, op.id, op.opType);
    succeeded += 1;
  }

  return { succeeded, failed, remaining: countPendingOps(documentId) };
}

/** Remove all pending ops for a document (e.g. after a full successful flush). */
export function clearPendingOps(documentId: number): void {
  try {
    localStorage.removeItem(storageKey(documentId));
    dispatchQueueChanged(documentId, 0);
  } catch { /* best-effort */ }
}

export function countPendingOps(documentId: number): number {
  return getPendingOps(documentId).length;
}
