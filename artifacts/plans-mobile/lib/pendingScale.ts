/**
 * Durable, latest-value retry storage for document scale calibration.
 *
 * A scale is document-wide rather than additive: each document retains only
 * its latest unsynchronized calibration. Storage mutations are short and
 * serialized independently from network sends, so a new calibration is
 * durable even while an older request is still in flight.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { setDocumentScale } from '@workspace/api-client-react';

export const PENDING_SCALE_KEY_PREFIX = '@plans_mobile_pending_scale_v1_';
export type DocumentScaleInput = Parameters<typeof setDocumentScale>[1];

export interface PendingScale {
  docId: number;
  input: DocumentScaleInput;
  sequence: number;
  createdAt: string;
}

let lastSequence = 0;
let storageLock: Promise<void> = Promise.resolve();
let sendTail: Promise<void> = Promise.resolve();

function storageKey(docId: number): string {
  return `${PENDING_SCALE_KEY_PREFIX}${docId}`;
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

async function load(docId: number): Promise<PendingScale | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(docId));
    return raw ? (JSON.parse(raw) as PendingScale) : null;
  } catch {
    return null;
  }
}

async function save(docId: number, item: PendingScale | null): Promise<void> {
  try {
    if (item) {
      await AsyncStorage.setItem(storageKey(docId), JSON.stringify(item));
    } else {
      await AsyncStorage.removeItem(storageKey(docId));
    }
  } catch {
    // Storage may be unavailable; leave the caller's visible scale unchanged.
  }
}

export function loadPendingScale(docId: number): Promise<PendingScale | null> {
  return withStorageLock(() => load(docId));
}

/** Store the newest calibration for this document, replacing any older retry. */
export function enqueuePendingScale(
  docId: number,
  input: DocumentScaleInput,
): Promise<PendingScale> {
  return withStorageLock(async () => {
    const item: PendingScale = {
      docId,
      input,
      sequence: nextSequence(),
      createdAt: new Date().toISOString(),
    };
    await save(docId, item);
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
  setScale: (input: DocumentScaleInput) => Promise<unknown>,
): Promise<FlushScaleResult> {
  const result = sendTail.then(async () => {
    const item = await loadPendingScale(docId);
    if (!item) return { pending: null, synced: null };

    try {
      await setScale(item.input);
    } catch {
      return { pending: await loadPendingScale(docId), synced: null };
    }

    const pending = await withStorageLock(async () => {
      // Only acknowledge the exact calibration that was sent. A newer value
      // can have been stored while the network request was unresolved.
      const current = await load(docId);
      if (current?.sequence === item.sequence) {
        await save(docId, null);
      }
      return load(docId);
    });
    return { pending, synced: item };
  });
  sendTail = result.then(
    () => {},
    () => {},
  );
  return result;
}