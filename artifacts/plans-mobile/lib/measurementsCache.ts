/**
 * measurementsCache — persists successfully fetched/created measurements to
 * AsyncStorage so they remain readable when the API is unreachable.
 *
 * Server list responses and local creates/deletes can complete out of order.
 * Per-item revisions stop an older list response from overwriting a newer
 * successful mutation.
 *
 * Key per document: `@plans_mobile_measurements_cache_v1_<docId>`
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Measurement } from '@workspace/api-client-react';

const cacheKey = (docId: number) =>
  `@plans_mobile_measurements_cache_v1_${docId}`;

interface Revision {
  action: 'upsert' | 'delete';
  updatedAt: number;
}

interface CacheRecord {
  measurements: Measurement[];
  revisions: Record<string, Revision>;
}

let cacheLock: Promise<void> = Promise.resolve();

function withCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = cacheLock.then(operation);
  cacheLock = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function readRecord(docId: number): Promise<CacheRecord> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(docId));
    if (!raw) return { measurements: [], revisions: {} };
    const parsed: unknown = JSON.parse(raw);

    // Migrate values written by the initial array-only cache format.
    if (Array.isArray(parsed)) {
      return { measurements: parsed as Measurement[], revisions: {} };
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as CacheRecord).measurements)
    ) {
      const record = parsed as CacheRecord;
      return {
        measurements: record.measurements,
        revisions: record.revisions ?? {},
      };
    }
  } catch {
    // Treat a corrupt or unavailable cache as empty.
  }
  return { measurements: [], revisions: {} };
}

async function writeRecord(docId: number, record: CacheRecord): Promise<void> {
  try {
    await AsyncStorage.setItem(cacheKey(docId), JSON.stringify(record));
  } catch {
    // non-fatal; best-effort cache
  }
}

export async function saveMeasurementsCache(
  docId: number,
  measurements: Measurement[],
  requestStartedAt = Date.now(),
): Promise<Measurement[]> {
  return withCacheLock(async () => {
    const current = await readRecord(docId);
    const currentById = new Map(current.measurements.map((m) => [m.id, m]));
    const incomingById = new Map(measurements.map((m) => [m.id, m]));
    const nextById = new Map<string, Measurement>();

    // Keep post-request local mutations over a server response that was
    // already in flight when those mutations succeeded.
    for (const [id, incoming] of incomingById) {
      const revision = current.revisions[id];
      if (revision && revision.updatedAt >= requestStartedAt) {
        if (revision.action === 'upsert') {
          const currentMeasurement = currentById.get(id);
          if (currentMeasurement) nextById.set(id, currentMeasurement);
        }
        // A newer local delete wins over the stale server item.
        continue;
      }
      nextById.set(id, incoming);
    }

    for (const [id, currentMeasurement] of currentById) {
      if (incomingById.has(id)) continue;
      const revision = current.revisions[id];
      if (revision?.action === 'upsert' && revision.updatedAt >= requestStartedAt) {
        nextById.set(id, currentMeasurement);
      }
    }

    // Keep only revisions newer than the request; older server data is now
    // authoritative and no longer needs local conflict protection.
    const revisions = Object.fromEntries(
      Object.entries(current.revisions).filter(
        ([, revision]) => revision.updatedAt >= requestStartedAt,
      ),
    );
    const next: CacheRecord = {
      measurements: Array.from(nextById.values()),
      revisions,
    };
    await writeRecord(docId, next);
    return next.measurements;
  });
}

export async function loadMeasurementsCache(
  docId: number,
): Promise<Measurement[]> {
  return withCacheLock(async () => (await readRecord(docId)).measurements);
}

/**
 * Upsert one measurement into the cache without a full refetch.
 * Called after a successful createMeasurement so the cache stays current.
 */
export async function upsertCachedMeasurement(
  docId: number,
  measurement: Measurement,
): Promise<Measurement[]> {
  return withCacheLock(async () => {
    const current = await readRecord(docId);
    const next: CacheRecord = {
      measurements: [
        ...current.measurements.filter((m) => m.id !== measurement.id),
        measurement,
      ],
      revisions: {
        ...current.revisions,
        [measurement.id]: { action: 'upsert', updatedAt: Date.now() },
      },
    };
    await writeRecord(docId, next);
    return next.measurements;
  });
}

/**
 * Remove one measurement from the cache.
 * Called after a successful deleteMeasurement.
 */
export async function removeCachedMeasurement(
  docId: number,
  measurementId: string,
): Promise<Measurement[]> {
  return withCacheLock(async () => {
    const current = await readRecord(docId);
    const next: CacheRecord = {
      measurements: current.measurements.filter((m) => m.id !== measurementId),
      revisions: {
        ...current.revisions,
        [measurementId]: { action: 'delete', updatedAt: Date.now() },
      },
    };
    await writeRecord(docId, next);
    return next.measurements;
  });
}
