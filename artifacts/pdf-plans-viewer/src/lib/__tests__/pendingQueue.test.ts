import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPendingOp,
  clearPendingOps,
  flushPendingOps,
  getCachedDocumentId,
  getPendingOps,
  getPendingScaleUpdate,
  removePendingOp,
  setCachedDocumentId,
  type PendingOp,
} from '../pendingQueue';
import { mergePendingState } from '../pendingState';

function createLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function isAlreadyApplied(op: PendingOp, error: unknown): boolean {
  const status = error && typeof error === 'object' && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
  return (op.opType === 'create_annotation' || op.opType === 'create_measurement')
    ? status === 409
    : status === 404;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('persistent pending-operation queue', () => {
  it('upgrades a legacy document-wide scale retry to page one before flushing', async () => {
    const documentId = 100;
    localStorage.setItem(`pdf-plans-pending-ops-${documentId}`, JSON.stringify([{
      opType: 'set_scale',
      documentId,
      id: 'scale',
      scale: { set: true, pixelsPerUnit: 10, unit: 'px', realWorldUnit: 'm' },
      timestamp: 1,
      sequence: 1,
    }]));

    expect(getPendingScaleUpdate(documentId, 1)).toMatchObject({
      id: 'scale:1',
      pageNumber: 1,
      pixelsPerUnit: 3.048,
      scaleKind: 'custom',
    });
    const flushed: PendingOp[] = [];
    await flushPendingOps(documentId, async (op) => { flushed.push(op); }, isAlreadyApplied);
    expect(flushed).toMatchObject([{ opType: 'set_scale', pageNumber: 1 }]);
    expect(getPendingOps(documentId)).toEqual([]);
  });

  it('replays an annotation create before its delete when the create fails later', async () => {
    const documentId = 101;
    const id = 'annotation-a';

    // The create committed, but its HTTP response was lost. On the client it is
    // queued as a failed create; the later offline delete must remain queued too.
    // Simulate the delete request failing first, before the original create
    // request times out. Persistence must still use user-action sequence.
    const createOp: PendingOp = {
      opType: 'create_annotation',
      documentId,
      id,
      pageNumber: 1,
      type: 'text',
      fabricData: { id, text: 'Temporary note' },
      timestamp: 1,
      sequence: 1,
    };
    const deleteOp: PendingOp = {
      opType: 'delete_annotation',
      documentId,
      id,
      timestamp: 2,
      sequence: 2,
    };

    addPendingOp(deleteOp);
    addPendingOp(createOp);

    // Simulate reopening this same PDF while the API is still offline. The
    // cached identity finds the queue and pending data can be rendered before
    // attempting any remote request.
    const hash = 'plan-a.pdf-1234';
    setCachedDocumentId(hash, documentId);
    expect(getCachedDocumentId(hash)).toBe(documentId);
    const offlineRestored = mergePendingState({}, {}, getPendingOps(documentId));
    // The delete remains reflected locally, so the annotation is not
    // resurrected while the app is offline.
    expect(offlineRestored.annotations[1] ?? []).toEqual([]);

    expect(getPendingOps(documentId).map((op) => op.opType)).toEqual([
      'create_annotation',
      'delete_annotation',
    ]);

    const serverIds = new Set([id]);
    const calls: string[] = [];
    const result = await flushPendingOps(
      documentId,
      async (op) => {
        calls.push(op.opType);
        if (op.opType === 'create_annotation') {
          // It already exists because the first request committed.
          throw statusError(409);
        }
        if (op.opType === 'delete_annotation') {
          serverIds.delete(op.id);
        }
      },
      isAlreadyApplied,
    );

    expect(calls).toEqual(['create_annotation', 'delete_annotation']);
    expect(serverIds.has(id)).toBe(false);
    expect(result).toMatchObject({ succeeded: 2, failed: false, remaining: 0 });
    expect(getPendingOps(documentId)).toEqual([]);
  });

  it('restores an unsaved annotation immediately when a known PDF is reopened offline', () => {
    const documentId = 104;
    const hash = 'plan-b.pdf-5678';
    const id = 'annotation-offline';

    setCachedDocumentId(hash, documentId);
    addPendingOp({
      opType: 'create_annotation',
      documentId,
      id,
      pageNumber: 2,
      type: 'note',
      fabricData: { id, text: 'Saved locally while offline' },
      timestamp: 1,
      sequence: 1,
    });

    // This mirrors Shell's offline loader: identify the PDF from the local
    // hash, then merge its local queue before any remote request succeeds.
    const restoredDocumentId = getCachedDocumentId(hash);
    expect(restoredDocumentId).toBe(documentId);
    const restored = mergePendingState({}, {}, getPendingOps(restoredDocumentId!));
    expect(restored.annotations[2]).toMatchObject([{ id, type: 'note' }]);
  });

  it('replays a measurement create before its delete when the create fails later', async () => {
    const documentId = 102;
    const id = 'measurement-a';

    const createOp: PendingOp = {
      opType: 'create_measurement',
      documentId,
      id,
      pageNumber: 1,
      type: 'distance',
      label: '10 ft',
      realWorldValue: 10,
      unit: 'ft',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      fabricData: { id },
      timestamp: 1,
      sequence: 1,
    };
    const deleteOp: PendingOp = {
      opType: 'delete_measurement',
      documentId,
      id,
      timestamp: 2,
      sequence: 2,
    };

    // The delete's request fails before the older create request does.
    addPendingOp(deleteOp);
    addPendingOp(createOp);

    const serverIds = new Set([id]);
    const calls: string[] = [];
    const result = await flushPendingOps(
      documentId,
      async (op) => {
        calls.push(op.opType);
        if (op.opType === 'create_measurement') {
          throw statusError(409);
        }
        if (op.opType === 'delete_measurement') {
          serverIds.delete(op.id);
        }
      },
      isAlreadyApplied,
    );

    expect(calls).toEqual(['create_measurement', 'delete_measurement']);
    expect(serverIds.has(id)).toBe(false);
    expect(result).toMatchObject({ succeeded: 2, failed: false, remaining: 0 });
  });

  it('does not send a later delete ahead of a create that is still failing', async () => {
    const documentId = 103;
    addPendingOp({
      opType: 'create_annotation',
      documentId,
      id: 'annotation-b',
      pageNumber: 1,
      type: 'text',
      fabricData: { id: 'annotation-b' },
      timestamp: 1,
      sequence: 1,
    });
    addPendingOp({
      opType: 'delete_annotation',
      documentId,
      id: 'annotation-b',
      timestamp: 2,
      sequence: 2,
    });

    const calls: string[] = [];
    const result = await flushPendingOps(
      documentId,
      async (op) => {
        calls.push(op.opType);
        throw new Error('Still offline');
      },
      isAlreadyApplied,
    );

    expect(calls).toEqual(['create_annotation']);
    expect(result).toMatchObject({ succeeded: 0, failed: true, remaining: 2 });
    clearPendingOps(documentId);
  });

  it('keeps a later delete durable when it reports success before its create resolves', async () => {
    const documentId = 105;
    const id = 'annotation-mixed-outcome';
    const serverIds = new Set<string>();

    // Both operations are stored when the user performs them. The DELETE may
    // report 204 while the delayed CREATE is still absent from the server.
    addPendingOp({
      opType: 'create_annotation',
      documentId,
      id,
      pageNumber: 1,
      type: 'note',
      fabricData: { id },
      timestamp: 1,
      sequence: 1,
    });
    addPendingOp({
      opType: 'delete_annotation',
      documentId,
      id,
      timestamp: 2,
      sequence: 2,
    });

    // The delete's initial success cannot remove its durable record while the
    // earlier create is unresolved, or reconnect would resurrect the note.
    expect(serverIds.delete(id)).toBe(false);
    expect(getPendingOps(documentId).map((op) => op.opType)).toEqual([
      'create_annotation',
      'delete_annotation',
    ]);

    await flushPendingOps(
      documentId,
      async (op) => {
        if (op.opType === 'create_annotation') serverIds.add(op.id);
        else serverIds.delete(op.id);
      },
      isAlreadyApplied,
    );

    expect(serverIds.has(id)).toBe(false);
    expect(getPendingOps(documentId)).toEqual([]);
  });

  it('restores a recalculated measurement update after an offline reload', () => {
    const documentId = 106;
    addPendingOp({
      opType: 'update_measurement',
      documentId,
      id: 'measurement-1',
      pageNumber: 1,
      label: '9.00 m²',
      realWorldValue: 9,
      unit: 'm²',
      fabricData: {
        type: 'Group',
        objects: [{ type: 'Text', text: '9.00 m²' }],
      },
      timestamp: 1,
      sequence: 1,
    });

    const restored = mergePendingState(
      {},
      {
        1: [{
          id: 'measurement-1',
          pageNumber: 1,
          type: 'area',
          label: '900.00 px²',
          realWorldValue: 900,
          unit: 'px²',
          points: [],
          data: {},
        }],
      },
      getPendingOps(documentId),
    );

    expect(restored.measurements[1][0]).toMatchObject({
      label: '9.00 m²',
      realWorldValue: 9,
      unit: 'm²',
      data: {
        type: 'Group',
        objects: [{ type: 'Text', text: '9.00 m²' }],
      },
    });
  });

  it('restores a corrected annotation alignment from the queue after an offline reload', () => {
    const documentId = 112;
    addPendingOp({
      opType: 'update_annotation',
      documentId,
      id: 'legacy-highlight',
      pageNumber: 2,
      fabricData: {
        type: 'Rect',
        left: 240,
        top: 180,
        scaleX: 1.25,
        scaleY: 1.25,
        viewerZoom: 1.5,
      },
      timestamp: 1,
      sequence: 1,
    });

    const restored = mergePendingState(
      {
        2: [{
          id: 'legacy-highlight',
          pageNumber: 2,
          type: 'highlight',
          data: { type: 'Rect', left: 80, top: 60 },
        }],
      },
      {},
      getPendingOps(documentId),
    );

    expect(restored.annotations[2][0].data).toMatchObject({
      left: 240,
      top: 180,
      scaleX: 1.25,
      scaleY: 1.25,
      viewerZoom: 1.5,
    });
  });

  const queuedScale = (
    documentId: number,
    pageNumber: number,
    pixelsPerUnit: number,
    sequence: number,
    scaleKind: 'preset' | 'custom' = 'preset',
  ) => ({
    opType: 'set_scale' as const,
    documentId,
    pageNumber,
    id: `scale:${pageNumber}`,
    isSet: true,
    pixelsPerUnit,
    unit: 'px',
    realWorldUnit: 'ft',
    scaleKind,
    presetRatio: scaleKind === 'preset' ? '1/4' as const : null,
    calibrationDistanceFeet: scaleKind === 'custom' ? 5 : null,
    timestamp: sequence,
    sequence,
  });

  it('keeps an offline page scale across reload and replays it first', async () => {
    const documentId = 107;
    addPendingOp(queuedScale(documentId, 2, 12, 1, 'custom'));

    expect(getPendingScaleUpdate(documentId, 2)).toMatchObject({
      pixelsPerUnit: 12,
      pageNumber: 2,
      realWorldUnit: 'ft',
    });

    const calls: string[] = [];
    await flushPendingOps(documentId, async (op) => { calls.push(op.opType); }, isAlreadyApplied);
    expect(calls).toEqual(['set_scale']);
    expect(getPendingOps(documentId)).toEqual([]);
  });

  it('overlays each queued scale only onto its matching remote page', () => {
    const documentId = 108;
    addPendingOp(queuedScale(documentId, 2, 36, 1));
    const merged = mergePendingState({}, {}, getPendingOps(documentId), {
      1: { set: true, pixelsPerUnit: 9, unit: 'px', realWorldUnit: 'ft', scaleKind: 'preset', presetRatio: '1/8', calibrationDistanceFeet: null },
      2: { set: true, pixelsPerUnit: 18, unit: 'px', realWorldUnit: 'ft', scaleKind: 'preset', presetRatio: '1/4', calibrationDistanceFeet: null },
    });

    expect(merged.scales[1].pixelsPerUnit).toBe(9);
    expect(merged.scales[2]).toMatchObject({ pixelsPerUnit: 36, presetRatio: '1/4' });
  });

  it('retains independent latest scale selections for two pages', () => {
    const documentId = 109;
    addPendingOp(queuedScale(documentId, 1, 9, 1));
    addPendingOp(queuedScale(documentId, 2, 18, 2));
    addPendingOp(queuedScale(documentId, 1, 72, 3));

    expect(getPendingOps(documentId)).toMatchObject([
      { pageNumber: 2, pixelsPerUnit: 18 },
      { pageNumber: 1, pixelsPerUnit: 72 },
    ]);
    removePendingOp(documentId, 'scale:1', 'set_scale', 1);
    expect(getPendingScaleUpdate(documentId, 1)?.pixelsPerUnit).toBe(72);
    expect(getPendingScaleUpdate(documentId, 2)?.pixelsPerUnit).toBe(18);
  });

  it('does not let an older acknowledgement erase a newer selection on the same page', async () => {
    const documentId = 110;
    addPendingOp(queuedScale(documentId, 1, 9, 1));
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const firstFlush = flushPendingOps(
      documentId,
      async (op) => {
        if (op.opType === 'set_scale') {
          markFirstStarted();
          await firstRequest;
        }
      },
      isAlreadyApplied,
    );
    await firstStarted;
    addPendingOp(queuedScale(documentId, 1, 72, 2));
    releaseFirst();
    await firstFlush;

    expect(getPendingScaleUpdate(documentId, 1)?.pixelsPerUnit).toBe(72);
  });

  it('replays a newer annotation alignment queued while the older update is in flight', async () => {
    const documentId = 111;
    const id = 'legacy-note';
    const update = (left: number, sequence: number): PendingOp => ({
      opType: 'update_annotation',
      documentId,
      id,
      pageNumber: 1,
      fabricData: { type: 'IText', left, viewerZoom: 1.5 },
      timestamp: sequence,
      sequence,
    });
    addPendingOp(update(100, 1));

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sentPositions: number[] = [];

    const firstFlush = flushPendingOps(
      documentId,
      async (op) => {
        if (op.opType !== 'update_annotation') return;
        sentPositions.push(op.fabricData.left as number);
        markFirstStarted();
        await firstRequest;
      },
      isAlreadyApplied,
    );
    await firstStarted;
    addPendingOp(update(240, 2));
    releaseFirst();
    await firstFlush;

    expect(sentPositions).toEqual([100]);
    expect(getPendingOps(documentId)).toMatchObject([
      { opType: 'update_annotation', fabricData: { left: 240 }, sequence: 2 },
    ]);

    await flushPendingOps(
      documentId,
      async (op) => {
        if (op.opType === 'update_annotation') {
          sentPositions.push(op.fabricData.left as number);
        }
      },
      isAlreadyApplied,
    );
    expect(sentPositions).toEqual([100, 240]);
    expect(getPendingOps(documentId)).toEqual([]);
  });
});