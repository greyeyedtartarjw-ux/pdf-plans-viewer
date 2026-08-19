import { describe, expect, it } from 'vitest';
import { rebuildFabricPage } from '../fabricPageState';

function createCanvas() {
  const objects: Array<{ id?: string; source: string }> = [];
  return {
    objects,
    clears: 0,
    renders: 0,
    clear() {
      this.clears += 1;
      this.objects.length = 0;
    },
    add(object: { id?: string; source: string }) {
      this.objects.push(object);
    },
    renderAll() {
      this.renders += 1;
    },
  };
}

describe('Fabric page restoration', () => {
  it('renders pending offline state after the canvas initialized empty, then replaces it on hydration', async () => {
    const canvas = createCanvas();
    const enliven = async ([data]: unknown[]) => [{ source: (data as { source: string }).source }];

    // Page rendering initializes Fabric before the offline API request fails.
    await rebuildFabricPage(canvas, {}, {}, 1, enliven, () => false);
    expect(canvas.objects).toEqual([]);

    // Offline recovery arrives later and must visibly render its queued work.
    await rebuildFabricPage(
      canvas,
      { 1: [{ id: 'pending-note', data: { source: 'offline' } }] },
      {},
      1,
      enliven,
      () => false,
    );
    expect(canvas.objects).toEqual([{ id: 'pending-note', source: 'offline' }]);

    // Reconnect hydration replaces the snapshot on the same initialized canvas.
    await rebuildFabricPage(
      canvas,
      { 1: [{ id: 'server-note', data: { source: 'hydrated' } }] },
      {},
      1,
      enliven,
      () => false,
    );
    expect(canvas.objects).toEqual([{ id: 'server-note', source: 'hydrated' }]);
  });

  it('does not paint stale async objects after a newer snapshot supersedes them', async () => {
    const canvas = createCanvas();
    let releaseStale: (() => void) | undefined;
    const staleDecode = new Promise<unknown[]>((resolve) => {
      releaseStale = () => resolve([{ source: 'stale' }]);
    });
    let cancelled = false;

    const staleRender = rebuildFabricPage(
      canvas,
      { 1: [{ id: 'old', data: { source: 'old' } }] },
      {},
      1,
      async () => staleDecode,
      () => cancelled,
    );

    cancelled = true;
    await rebuildFabricPage(
      canvas,
      { 1: [{ id: 'new', data: { source: 'new' } }] },
      {},
      1,
      async ([data]) => [{ source: (data as { source: string }).source }],
      () => false,
    );
    releaseStale!();
    expect(await staleRender).toBe(false);
    expect(canvas.objects).toEqual([{ id: 'new', source: 'new' }]);
  });
});