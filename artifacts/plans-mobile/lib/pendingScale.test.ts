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
    getAllKeys: vi.fn(async () => [...storage.keys()]),
  },
}));

import {
  enqueuePendingScale,
  flushAllPendingScales,
  flushPendingScale,
  loadPendingScale,
  type DocumentScaleInput,
} from './pendingScale';

const docId = 73;
const pageOne = 1;
const pageTwo = 2;

function scale(
  pixelsPerUnit: number,
  scaleKind: 'preset' | 'custom' = 'preset',
): DocumentScaleInput {
  return {
    isSet: true,
    pixelsPerUnit,
    unit: 'px',
    realWorldUnit: 'ft',
    scaleKind,
    presetRatio: scaleKind === 'preset' ? '1/4' : null,
    calibrationDistanceFeet: scaleKind === 'custom' ? 5 : null,
  };
}

describe('pending mobile scale calibration', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('restores a calibration after an offline app restart', async () => {
    await enqueuePendingScale(docId, pageOne, scale(12));

    // `loadPendingScale` models the newly mounted viewer reading AsyncStorage.
    expect((await loadPendingScale(docId, pageOne))?.input).toEqual(scale(12));
  });

  it('upgrades a legacy document-wide retry into a page-one feet calibration', async () => {
    storage.set('@plans_mobile_pending_scale_v1_73', JSON.stringify({
      docId,
      input: { isSet: true, pixelsPerUnit: 10, unit: 'px', realWorldUnit: 'm' },
      sequence: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));

    expect((await loadPendingScale(docId, pageOne))?.input).toMatchObject({
      pixelsPerUnit: 3.048,
      realWorldUnit: 'ft',
      scaleKind: 'custom',
      calibrationDistanceFeet: 1,
    });
    expect(storage.has('@plans_mobile_pending_scale_v1_73')).toBe(false);
  });

  it('keeps the latest calibration when a user recalibrates before reconnecting', async () => {
    await enqueuePendingScale(docId, pageOne, scale(4));
    await enqueuePendingScale(docId, pageOne, scale(9));

    expect((await loadPendingScale(docId, pageOne))?.input).toEqual(scale(9));
  });

  it('retains a failed calibration and eventually sends it after reconnecting', async () => {
    await enqueuePendingScale(docId, pageOne, scale(6, 'custom'));

    const failed = await flushPendingScale(docId, pageOne, async () => {
      throw new Error('offline');
    });
    expect(failed.pending?.input).toEqual(scale(6, 'custom'));

    const sent: DocumentScaleInput[] = [];
    const recovered = await flushPendingScale(docId, pageOne, async (_page, input) => {
      sent.push(input);
    });
    expect(sent).toEqual([scale(6, 'custom')]);
    expect(recovered.pending).toBeNull();
    expect(await loadPendingScale(docId, pageOne)).toBeNull();
  });

  it('keeps page calibrations independent and only replaces the matching page', async () => {
    await enqueuePendingScale(docId, pageOne, scale(9));
    await enqueuePendingScale(docId, pageTwo, scale(18));
    await enqueuePendingScale(docId, pageOne, scale(36));

    expect((await loadPendingScale(docId, pageOne))?.input.pixelsPerUnit).toBe(36);
    expect((await loadPendingScale(docId, pageTwo))?.input.pixelsPerUnit).toBe(18);
  });

  it('flushes pending scales from every page when connectivity returns', async () => {
    await enqueuePendingScale(docId, pageOne, scale(9));
    await enqueuePendingScale(docId, pageTwo, scale(36, 'custom'));
    const sent: Array<[number, number]> = [];

    await flushAllPendingScales(docId, async (pageNumber, input) => {
      sent.push([pageNumber, input.pixelsPerUnit]);
    });

    expect(sent).toEqual([[pageOne, 9], [pageTwo, 36]]);
    expect(await loadPendingScale(docId, pageOne)).toBeNull();
    expect(await loadPendingScale(docId, pageTwo)).toBeNull();
  });

  it('does not let an older acknowledgement erase a newer page-one choice', async () => {
    await enqueuePendingScale(docId, pageOne, scale(9));
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstFlush = flushPendingScale(docId, pageOne, async (_page, input) => {
      expect(input.pixelsPerUnit).toBe(9);
      firstStarted();
      await firstRequest;
    });
    await started;

    await enqueuePendingScale(docId, pageOne, scale(72));
    releaseFirst();
    await firstFlush;
    expect((await loadPendingScale(docId, pageOne))?.input.pixelsPerUnit).toBe(72);
  });
});