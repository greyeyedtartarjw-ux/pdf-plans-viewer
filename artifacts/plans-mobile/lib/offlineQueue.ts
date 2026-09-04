/**
 * offlineQueue — pure, serialized AsyncStorage helpers for pending measurements.
 *
 * All mutations go through `withLock` so concurrent enqueue/dequeue/flush
 * calls cannot overwrite each other's writes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const PENDING_MEASUREMENTS_KEY = '@plans_mobile_pending_measurements_v1';

export interface PendingMeasurement {
  localId: string;
  docId: number;
  /** Missing on older records; those are regular create operations. */
  operation?: 'create' | 'update';
  input: {
    id: string;
    pageNumber: number;
    type: 'distance' | 'area';
    label: string;
    valueLabel: string;
    realWorldValue: number;
    unit: string;
    points: Record<string, unknown>[];
    fabricData: Record<string, unknown>;
  };
  createdAt: string;
}

// ─── serialization lock ──────────────────────────────────────────────────────
// A single promise chain that serializes every queue mutation.
// Each call appends to the chain and never lets an error break it.

let _lock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = _lock.then(fn);
  _lock = result.then(
    () => {},
    () => {},
  );
  return result;
}

// ─── internal read/write (called only inside withLock) ───────────────────────

async function _load(): Promise<PendingMeasurement[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_MEASUREMENTS_KEY);
    return raw ? (JSON.parse(raw) as PendingMeasurement[]) : [];
  } catch {
    return [];
  }
}

async function _save(queue: PendingMeasurement[]): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_MEASUREMENTS_KEY, JSON.stringify(queue));
  } catch {
    // storage failure — caller still gets the updated in-memory list
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Read the current queue without modifying it. Safe to call outside the lock. */
export function loadQueue(): Promise<PendingMeasurement[]> {
  return withLock(_load);
}

/**
 * Add an item to the queue (idempotent by localId).
 * Returns the new queue.
 */
export function enqueue(item: PendingMeasurement): Promise<PendingMeasurement[]> {
  return withLock(async () => {
    const existing = await _load();
    const next = [...existing.filter((p) => p.localId !== item.localId), item];
    await _save(next);
    return next;
  });
}

/**
 * Remove an item from the queue by localId.
 * Returns the new queue.
 */
export function dequeue(localId: string): Promise<PendingMeasurement[]> {
  return withLock(async () => {
    const existing = await _load();
    const next = existing.filter((p) => p.localId !== localId);
    await _save(next);
    return next;
  });
}

/**
 * Attempt to sync all pending items via `syncFn`.
 * Successfully synced items are removed; failures stay for the next attempt.
 * Returns the remaining queue after the flush.
 */
export function flush(
  syncFn: (item: PendingMeasurement) => Promise<unknown>,
): Promise<PendingMeasurement[]> {
  return withLock(async () => {
    const queue = await _load();
    let remaining = [...queue];

    for (const item of queue) {
      try {
        await syncFn(item);
        remaining = remaining.filter((p) => p.localId !== item.localId);
      } catch {
        // Leave for next retry
      }
    }

    await _save(remaining);
    return remaining;
  });
}

/** Replace the full queue (used in tests / reset flows). */
export function resetQueue(queue: PendingMeasurement[] = []): Promise<void> {
  return withLock(async () => {
    await _save(queue);
  });
}
