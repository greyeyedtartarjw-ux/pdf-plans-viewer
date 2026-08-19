import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

import {
  enqueuePendingScale,
  flushPendingScale,
  loadPendingScale,
  type DocumentScaleInput,
} from './pendingScale';

const docId = 73;

function scale(pixelsPerUnit: number, realWorldUnit = 'm'): DocumentScaleInput {
  return { isSet: true, pixelsPerUnit, unit: 'px', realWorldUnit };
}

describe('pending mobile scale calibration', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('restores a calibration after an offline app restart', async () => {
    await enqueuePendingScale(docId, scale(12, 'ft'));

    // `loadPendingScale` models the newly mounted viewer reading AsyncStorage.
    expect((await loadPendingScale(docId))?.input).toEqual(scale(12, 'ft'));
  });

  it('keeps the latest calibration when a user recalibrates before reconnecting', async () => {
    await enqueuePendingScale(docId, scale(4, 'm'));
    await enqueuePendingScale(docId, scale(9, 'ft'));

    expect((await loadPendingScale(docId))?.input).toEqual(scale(9, 'ft'));
  });

  it('retains a failed calibration and eventually sends it after reconnecting', async () => {
    await enqueuePendingScale(docId, scale(6, 'm'));

    const failed = await flushPendingScale(docId, async () => {
      throw new Error('offline');
    });
    expect(failed.pending?.input).toEqual(scale(6, 'm'));

    const sent: DocumentScaleInput[] = [];
    const recovered = await flushPendingScale(docId, async (input) => {
      sent.push(input);
    });
    expect(sent).toEqual([scale(6, 'm')]);
    expect(recovered.pending).toBeNull();
    expect(await loadPendingScale(docId)).toBeNull();
  });

  it('persists a newer calibration before an older in-flight request settles', async () => {
    await enqueuePendingScale(docId, scale(2, 'm'));

    let releaseFirst!: () => void;
    const waitForFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const sent: number[] = [];

    const firstFlush = flushPendingScale(docId, async (input) => {
      sent.push(input.pixelsPerUnit);
      firstStarted();
      await waitForFirst;
    });
    await started;

    // The newest scale must commit to AsyncStorage before the slow first
    // request resolves, so a reload at this point still restores it.
    await enqueuePendingScale(docId, scale(8, 'ft'));
    expect((await loadPendingScale(docId))?.input).toEqual(scale(8, 'ft'));

    const secondFlush = flushPendingScale(docId, async (input) => {
      sent.push(input.pixelsPerUnit);
    });
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);
    expect(sent).toEqual([2, 8]);
    expect(await loadPendingScale(docId)).toBeNull();
  });
});