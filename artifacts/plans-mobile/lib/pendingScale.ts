/**
 * Durable, latest-value retry storage for page scale calibration.
 *
 * A scale is page-specific: each document-page pair retains only its latest
 * unsynchronized calibration. Storage mutations are short and
 * serialized independently from network sends, so a new calibration is
 * durable even while an older request is still in flight.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { setDocumentPageScale } from '@workspace/api-client-react';

export const PENDING_SCALE_KEY_PREFIX = '@plans_mobile_pending_page_scale_v2_';
const LEGACY_PENDING_SCALE_KEY_PREFIX = '@plans_mobile_pending_scale_v1_';
export type DocumentScaleInput = Parameters<typeof setDocumentPageScale>[2];

export interface PendingScale {
  docId: number;
  pageNumber: number;
  input: DocumentScaleInput;
  sequence: number;
  createdAt: string;
}


let lastSequence = 0;
let storageLock: Promise<void> = Promise.resolve();
let sendTail: Promise<void> = Promise.resolve();

function storageKey(docId: number, pageNumber: number): string {
  return `${PENDING_SCALE_KEY_PREFIX}${docId}_${pageNumber}`;
}

function legacyStorageKey(docId: number): string {
  return `${LEGACY_PENDING_SCALE_KEY_PREFIX}${docId}`;
}

function legacyPixelsPerFoot(pixelsPerUnit: number, unit: unknown): number | null {
  const multipliers: Record<string, number> = { ft: 1, m: 0.3048, cm: 30.48, mm: 304.8, in: 12 };
  const multiplier = typeof unit === 'string' ? multipliers[unit] : undefined;
  return multiplier && Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0
    ? pixelsPerUnit * multiplier
    : null;
}

function nextSequence(): number {
  lastSequence = Math.max(Date.now() * 1_000, lastSequence + 1);
  return lastSequence;
}

function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = storageLock.then(fn);
  storageLock = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function load(docId: number, pageNumber: number): Promise<PendingScale | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(docId, pageNumber));
    return raw ? (JSON.parse(raw) as PendingScale) : null;
  } catch {
    return null;
  }
}

async function save(docId: number, pageNumber: number, item: PendingScale | null): Promise<void> {
  try {
    if (item) {
      await AsyncStorage.setItem(storageKey(docId, pageNumber), JSON.stringify(item));
    } else {
      await AsyncStorage.removeItem(storageKey(docId, pageNumber));
    }
  } catch {
    // Storage may be unavailable; leave the caller's visible scale unchanged.
  }
}

async function migrateLegacyScale(docId: number): Promise<void> {
  try {
    if (await load(docId, 1)) return;
    const raw = await AsyncStorage.getItem(legacyStorageKey(docId));
    if (!raw) return;
    const legacy = JSON.parse(raw) as {
      input?: { isSet?: boolean; pixelsPerUnit?: number; unit?: string; realWorldUnit?: string };
      sequence?: number;
      createdAt?: string;
    };
    const input = legacy.input;
    const pixelsPerUnit = typeof input?.pixelsPerUnit === 'number'
      ? legacyPixelsPerFoot(input.pixelsPerUnit, input.realWorldUnit)
      : null;
    if (input?.isSet && pixelsPerUnit !== null) {
      await save(docId, 1, {
        docId,
        pageNumber: 1,
        input: {
          isSet: true,
          pixelsPerUnit,
          unit: 'px',
          realWorldUnit: 'ft',
          scaleKind: 'custom',
          presetRatio: null,
          calibrationDistanceFeet: 1,
        },
        sequence: typeof legacy.sequence === 'number' ? legacy.sequence : nextSequence(),
        createdAt: legacy.createdAt ?? new Date().toISOString(),
      });
    }
    await AsyncStorage.removeItem(legacyStorageKey(docId));
  } catch {
    // Keep the legacy entry untouched if it cannot be safely migrated.
  }
}

export function loadPendingScale(docId: number, pageNumber: number): Promise<PendingScale | null> {
  return withStorageLock(async () => {
    await migrateLegacyScale(docId);
    return load(docId, pageNumber);
  });
}

/** Store the newest calibration for one page, replacing only that page's older retry. */
export function enqueuePendingScale(
  docId: number,
  pageNumber: number,
  input: DocumentScaleInput,
): Promise<PendingScale> {
  return withStorageLock(async () => {
    const item: PendingScale = {
      docId,
      pageNumber,
      input,
      sequence: nextSequence(),
      createdAt: new Date().toISOString(),
    };
    await save(docId, pageNumber, item);
    return item;
  });
}

export interface FlushScaleResult {
  pending: PendingScale | null;
  synced: PendingScale | null;
}

/**
 * Send the current pending scale once. On failure it remains stored for the
 * next reconnect or app launch. Sends are serialized separately from storage:
 * a later calibration can persist immediately while an older request is in
 * flight, then it is sent after that older request finishes.
 */
export function flushPendingScale(
  docId: number,
  pageNumber: number,
  setScale: (pageNumber: number, input: DocumentScaleInput) => Promise<unknown>,
): Promise<FlushScaleResult> {
  const result = sendTail.then(async () => {
    const item = await loadPendingScale(docId, pageNumber);
    if (!item) return { pending: null, synced: null };

    try {
      await setScale(pageNumber, item.input);
    } catch {
      return { pending: await loadPendingScale(docId, pageNumber), synced: null };
    }

    const pending = await withStorageLock(async () => {
      // Only acknowledge the exact calibration that was sent. A newer value
      // can have been stored while the network request was unresolved.
      const current = await load(docId, pageNumber);
      if (current?.sequence === item.sequence) {
        await save(docId, pageNumber, null);
      }
      return load(docId, pageNumber);
    });
    return { pending, synced: item };
  });
  sendTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Flush every page-scale retry stored for a document after reconnecting. */
export async function flushAllPendingScales(
  docId: number,
  setScale: (pageNumber: number, input: DocumentScaleInput) => Promise<unknown>,
): Promise<FlushScaleResult[]> {
  let keys: readonly string[] = [];
  try {
    await withStorageLock(() => migrateLegacyScale(docId));
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return [];
  }
  const prefix = `${PENDING_SCALE_KEY_PREFIX}${docId}_`;
  const pages = keys
    .filter((key) => key.startsWith(prefix))
    .map((key) => Number(key.slice(prefix.length)))
    .filter((pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber > 0);

  return Promise.all(
    pages.map((pageNumber) => flushPendingScale(docId, pageNumber, setScale)),
  );
}