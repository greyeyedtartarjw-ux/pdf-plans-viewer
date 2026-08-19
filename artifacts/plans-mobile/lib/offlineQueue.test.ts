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
  dequeue,
  enqueue,
  flush,
  loadQueue,
  resetQueue,
  type PendingMeasurement,
} from './offlineQueue';

function pending(localId: string): PendingMeasurement {
  return {
    localId,
    docId: 42,
    input: {
      id: localId,
      pageNumber: 1,
      type: 'distance',
      label: '12.0 px',
      realWorldValue: 12,
      unit: 'px',
      points: [{ x: 0, y: 0 }, { x: 12, y: 0 }],
      fabricData: { platform: 'mobile' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
  };
}

describe('offline measurement queue', () => {
  beforeEach(async () => {
    storage.clear();
    await resetQueue();
  });

  it('persists a queued offline measurement for a later app session', async () => {
    await enqueue(pending('offline-a'));

    // `loadQueue` models a new screen/app session reading AsyncStorage.
    expect(await loadQueue()).toEqual([pending('offline-a')]);
  });

  it('removes only successfully synced measurements and retains failures', async () => {
    await enqueue(pending('saved'));
    await enqueue(pending('retry'));

    const remaining = await flush(async (_docId, input) => {
      if (input.id === 'retry') throw new Error('offline');
      return { id: input.id };
    });

    expect(remaining.map((item) => item.localId)).toEqual(['retry']);
    expect((await loadQueue()).map((item) => item.localId)).toEqual(['retry']);
  });

  it('does not lose a new measurement enqueued while an existing flush is active', async () => {
    await enqueue(pending('being-synced'));

    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });

    const flushing = flush(async () => {
      syncStarted();
      await syncGate;
    });
    await started;

    // This waits behind the queue lock until the flush has committed, then
    // appends rather than being overwritten by the flush's stale snapshot.
    const enqueuing = enqueue(pending('created-during-sync'));
    releaseSync();
    await Promise.all([flushing, enqueuing]);

    expect((await loadQueue()).map((item) => item.localId)).toEqual([
      'created-during-sync',
    ]);
    await dequeue('created-during-sync');
  });
});