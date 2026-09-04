/**
 * Persistent queue for annotation/measurement/scale operations that failed to reach
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
 *   are always preserved. Scale updates use one stable ID so the latest
 *   calibration replaces an older pending calibration.
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

export interface PendingAnnotationUpdate {
  opType: 'update_annotation';
  documentId: number;
  id: string;
  pageNumber: number;
  fabricData: Record<string, unknown>;
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
  valueLabel: string;
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
  valueLabel: string;
  realWorldValue: number;
  unit: string;
  fabricData: Record<string, unknown>;
  timestamp: number;
  sequence: number;
}

export interface PendingScaleUpdate {
  opType: 'set_scale';
  documentId: number;
  /** One queued setting per document-page pair; later choices replace earlier ones. */
  id: string;
  pageNumber: number;
  isSet: boolean;
  pixelsPerUnit: number;
  unit: string;
  realWorldUnit: string;
  scaleKind: 'preset' | 'custom';
  presetRatio: '1/8' | '1/4' | '3/6' | '3/4' | '1' | null;
  calibrationDistanceFeet: number | null;
  timestamp: number;
  sequence: number;
}

export type PendingOp =
  | PendingAnnotationCreate
  | PendingAnnotationDelete
  | PendingAnnotationUpdate
  | PendingMeasurementCreate
  | PendingMeasurementDelete
  | PendingMeasurementUpdate
  | PendingScaleUpdate;

export interface PendingSaveEntry {
  fn: () => Promise<unknown>;
  errorTitle: string;
  pendingOp?: PendingOp;
}

export function pendingMeasurementValueLabel(
  measurement: { valueLabel?: string; realWorldValue: number; unit: string },
): string {
  return measurement.valueLabel ?? `${measurement.realWorldValue.toFixed(2)} ${measurement.unit}`;
}
let lastSequence = 0;
const flushLanes = new Map<number, Promise<void>>();

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

function legacyPixelsPerFoot(pixelsPerUnit: number, realWorldUnit: unknown): number | null {
  const units: Record<string, number> = {
    ft: 1,
    m: 0.3048,
    cm: 30.48,
    mm: 304.8,
    in: 12,
  };
  const multiplier = typeof realWorldUnit === 'string' ? units[realWorldUnit] : undefined;
  return multiplier && Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0
    ? pixelsPerUnit * multiplier
    : null;
}

/** Upgrade document-wide queued calibrations to a custom page-one scale. */
function migrateLegacyScaleOps(documentId: number, ops: unknown[]): PendingOp[] {
  let changed = false;
  const migrated = ops.flatMap((raw): PendingOp[] => {
    if (!raw || typeof raw !== 'object' || (raw as { opType?: unknown }).opType !== 'set_scale') {
      return [raw as PendingOp];
    }
    const legacy = raw as Record<string, unknown>;
    if (typeof legacy.pageNumber === 'number') return [legacy as unknown as PendingScaleUpdate];
    changed = true;
    const nested = legacy.scale && typeof legacy.scale === 'object'
      ? legacy.scale as Record<string, unknown>
      : legacy;
    const pixelsPerUnit = typeof nested.pixelsPerUnit === 'number'
      ? legacyPixelsPerFoot(nested.pixelsPerUnit, nested.realWorldUnit)
      : null;
    const isSet = nested.isSet === true || nested.set === true;
    if (!isSet || pixelsPerUnit === null) return [];
    return [{
      opType: 'set_scale',
      documentId,
      id: 'scale:1',
      pageNumber: 1,
      isSet: true,
      pixelsPerUnit,
      unit: 'px',
      realWorldUnit: 'ft',
      scaleKind: 'custom',
      presetRatio: null,
      calibrationDistanceFeet: 1,
      timestamp: typeof legacy.timestamp === 'number' ? legacy.timestamp : Date.now(),
      sequence: typeof legacy.sequence === 'number' ? legacy.sequence : Date.now() * 1_000,
    }];
  });
  if (changed) setPendingOps(documentId, migrated);
  return migrated;
}

export function getPendingOps(documentId: number): PendingOp[] {
  try {
    const raw = localStorage.getItem(storageKey(documentId));
    if (!raw) return [];
    return migrateLegacyScaleOps(documentId, JSON.parse(raw) as unknown[]).sort(comparePendingOps);
  } catch {
    return [];
  }
}

/** The latest local calibration for one page overrides its stale server value after reload. */
export function getPendingScaleUpdate(documentId: number, pageNumber: number): PendingScaleUpdate | undefined {
  return getPendingOps(documentId)
    .filter((op): op is PendingScaleUpdate => op.opType === 'set_scale' && op.pageNumber === pageNumber)
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

/**
 * Add a callback to the live retry queue, replacing an earlier callback for
 * the same logical operation. This mirrors addPendingOp's persistent
 * deduplication so reconnect cannot send a rapid duplicate save twice.
 */
export function upsertPendingSaveEntry(
  entries: PendingSaveEntry[],
  entry: PendingSaveEntry & { pendingOp: PendingOp },
): PendingSaveEntry[] {
  const { pendingOp } = entry;
  return [
    ...entries.filter((candidate) =>
      !candidate.pendingOp
      || candidate.pendingOp.documentId !== pendingOp.documentId
      || candidate.pendingOp.id !== pendingOp.id
      || candidate.pendingOp.opType !== pendingOp.opType,
    ),
    entry,
  ];
}
/** Remove a single operation after it has been successfully flushed. */
export function removePendingOp(
  documentId: number,
  id: string,
  opType: PendingOp['opType'],
  sequence?: number,
): void {
  const ops = getPendingOps(documentId);
  const filtered = ops.filter(o => !(
    o.id === id
    && o.opType === opType
    && (sequence === undefined || o.sequence === sequence)
  ));
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
export function flushPendingOps(
  documentId: number,
  execute: (op: PendingOp) => Promise<void>,
  isAlreadyApplied: (op: PendingOp, error: unknown) => boolean,
): Promise<{ succeeded: number; failed: boolean; remaining: number }> {
  const previousFlush = flushLanes.get(documentId) ?? Promise.resolve();
  const operation = previousFlush.then(async () => {
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

      // An in-flight older request must not remove a newer replacement.
      removePendingOp(op.documentId, op.id, op.opType, op.sequence);
      succeeded += 1;
    }

    return { succeeded, failed, remaining: countPendingOps(documentId) };
  });
  const lane = operation.then(
    () => undefined,
    () => undefined,
  );
  flushLanes.set(documentId, lane);
  void lane.finally(() => {
    if (flushLanes.get(documentId) === lane) flushLanes.delete(documentId);
  });
  return operation;
}

/** Remove all pending ops for a document (e.g. after a full successful flush). */
export function clearPendingOps(documentId: number): void {
  try {
    localStorage.removeItem(storageKey(documentId));
    dispatchQueueChanged(documentId, 0);
  } catch { /* best-effort */ }
}

/** Restore a native desktop snapshot into the browser queue after relaunch. */
export function restorePendingOps(documentId: number, ops: PendingOp[]): void {
  const merged = new Map<string, PendingOp>();
  for (const op of [...ops, ...getPendingOps(documentId)]) {
    if (op.documentId !== documentId) continue;
    const key = `${op.opType}:${op.id}`;
    const current = merged.get(key);
    if (!current || comparePendingOps(current, op) < 0) merged.set(key, op);
  }
  const ordered = [...merged.values()].sort(comparePendingOps);
  setPendingOps(documentId, ordered);
  dispatchQueueChanged(documentId, ordered.length);
}

export function countPendingOps(documentId: number): number {
  return getPendingOps(documentId).length;
}
