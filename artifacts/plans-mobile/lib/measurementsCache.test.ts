import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
  },
}));

import {
  loadMeasurementsCache,
  removeCachedMeasurement,
  saveMeasurementsCache,
  upsertCachedMeasurement,
} from './measurementsCache';
import type { Measurement } from '@workspace/api-client-react';

const first: Measurement = {
  id: 'confirmed-a',
  documentId: 42,
  pageNumber: 1,
  type: 'distance',
  label: '12.0 px',
  realWorldValue: 12,
  unit: 'px',
  points: [{ x: 0, y: 0 }, { x: 12, y: 0 }],
  fabricData: { platform: 'mobile' },
  createdAt: '2026-08-19T00:00:00.000Z',
};

describe('confirmed measurements cache', () => {
  beforeEach(() => storage.clear());

  it('restores confirmed measurements after an app restart with no API response', async () => {
    await saveMeasurementsCache(42, [first]);

    // A fresh cache read represents reopening the plan without connectivity.
    expect(await loadMeasurementsCache(42)).toEqual([first]);
  });

  it('keeps the cache current after create and delete operations', async () => {
    await saveMeasurementsCache(42, [first]);
    const second = { ...first, id: 'confirmed-b', label: '20.0 px' };

    await upsertCachedMeasurement(42, second);
    expect((await loadMeasurementsCache(42)).map((item) => item.id)).toEqual([
      'confirmed-a',
      'confirmed-b',
    ]);

    await removeCachedMeasurement(42, 'confirmed-a');
    expect((await loadMeasurementsCache(42)).map((item) => item.id)).toEqual([
      'confirmed-b',
    ]);
  });

  it('does not let a stale list response erase a measurement confirmed after the request began', async () => {
    await saveMeasurementsCache(42, [first], 0);
    const createdAfterRequest = {
      ...first,
      id: 'created-after-list-start',
      label: '36.0 px',
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);

    await upsertCachedMeasurement(42, createdAfterRequest);
    // This response was requested in the same millisecond as the create.
    // Equality must favor the local mutation because the response may have
    // begun just before it and cannot know about it.
    const reconciled = await saveMeasurementsCache(42, [first], 100);

    // Query functions return this reconciled result directly, so the newly
    // confirmed item remains renderable even before another API round trip.
    expect(reconciled.map((item) => item.id)).toEqual([
      'confirmed-a',
      'created-after-list-start',
    ]);
    expect(await loadMeasurementsCache(42)).toEqual(reconciled);
    now.mockRestore();
  });

  it('retains simultaneous successful creates in the cached measurement list', async () => {
    const second = { ...first, id: 'confirmed-b', label: '20.0 px' };

    await Promise.all([
      upsertCachedMeasurement(42, first),
      upsertCachedMeasurement(42, second),
    ]);

    expect((await loadMeasurementsCache(42)).map((item) => item.id).sort()).toEqual([
      'confirmed-a',
      'confirmed-b',
    ]);
  });

  it('lets a newer authoritative server list replace obsolete cached data', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    await upsertCachedMeasurement(42, first);
    const updatedOnServer = { ...first, label: '18.0 px' };

    // This request starts after the cache revision, so its server response is
    // authoritative and should replace the older local copy.
    const reconciled = await saveMeasurementsCache(42, [updatedOnServer], 101);

    expect(reconciled).toEqual([updatedOnServer]);
    expect(await loadMeasurementsCache(42)).toEqual([updatedOnServer]);
    now.mockRestore();
  });
});