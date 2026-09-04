import { describe, expect, it } from 'vitest';
import {
  createLegacyZoomResolver,
  hasExplicitViewerZoom,
  rebuildFabricPage,
} from '../fabricPageState';
import { updateFabricMeasurementLabel } from '../measurementUtils';

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
  it('only treats positive finite viewer zoom metadata as an explicit alignment baseline', () => {
    expect(hasExplicitViewerZoom({ viewerZoom: 1.5 })).toBe(true);
    expect(hasExplicitViewerZoom({})).toBe(false);
    expect(hasExplicitViewerZoom({ viewerZoom: 0 })).toBe(false);
    expect(hasExplicitViewerZoom({ viewerZoom: Number.NaN })).toBe(false);
  });

  it.each([
    ['highlight', { type: 'Rect', left: 120, top: 80, width: 40, height: 20 }],
    ['text note', { type: 'IText', left: 120, top: 80, text: 'Legacy note' }],
    ['distance measurement', { type: 'Group', left: 120, top: 80, objects: [{ type: 'Line' }, { type: 'Text' }] }],
    ['area measurement', { type: 'Group', left: 120, top: 80, objects: [{ type: 'Polygon' }, { type: 'Text' }] }],
  ])('keeps a legacy %s anchored after zooming', async (_name, data) => {
    const canvas = createCanvas();
    const resolveLegacyZoom = createLegacyZoomResolver();
    const enliven = async ([serialized]: unknown[]) => {
      const saved = serialized as { left: number; top: number; type: string };
      return [{
        source: saved.type,
        left: saved.left,
        top: saved.top,
        scaleX: 1,
        scaleY: 1,
        set(properties: Record<string, number>) {
          Object.assign(this, properties);
        },
      }];
    };
    const annotations = data.type === 'Rect' || data.type === 'IText'
      ? { 1: [{ id: `legacy-${data.type}`, data }] }
      : {};
    const measurements = data.type === 'Group'
      ? { 1: [{ id: `legacy-${data.objects[0].type}`, data }] }
      : {};

    await rebuildFabricPage(
      canvas, annotations, measurements, 1, enliven, () => false, 1.5, resolveLegacyZoom,
    );
    expect(canvas.objects[0]).toMatchObject({ left: 120, top: 80, scaleX: 1, scaleY: 1 });

    await rebuildFabricPage(
      canvas, annotations, measurements, 1, enliven, () => false, 3, resolveLegacyZoom,
    );
    expect(canvas.objects[0]).toMatchObject({ left: 240, top: 160, scaleX: 2, scaleY: 2 });
  });

  it('continues to use persisted zoom metadata when it is available', async () => {
    const canvas = createCanvas();
    await rebuildFabricPage(
      canvas,
      { 1: [{ id: 'modern', data: { source: 'modern', viewerZoom: 2 } }] },
      {},
      1,
      async () => [{
        source: 'modern',
        left: 50,
        top: 25,
        scaleX: 1,
        scaleY: 1,
        set(properties: Record<string, number>) {
          Object.assign(this, properties);
        },
      }],
      () => false,
      3,
      createLegacyZoomResolver(),
    );
    expect(canvas.objects[0]).toMatchObject({ left: 75, top: 37.5, scaleX: 1.5, scaleY: 1.5 });
  });

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

  it('renders recalibrated distance and area labels from persisted Fabric data', async () => {
    const canvas = createCanvas();
    const distanceData = updateFabricMeasurementLabel({
      type: 'Group',
      objects: [{ type: 'Line' }, { type: 'Text', text: '30.00 px' }],
    }, '3.00 m');
    const areaData = updateFabricMeasurementLabel({
      type: 'Group',
      objects: [{ type: 'Polygon' }, { type: 'Text', text: '900.00 px²' }],
    }, '9.00 m²');

    await rebuildFabricPage(
      canvas,
      {},
      {
        1: [
          { id: 'distance', data: distanceData },
          { id: 'area', data: areaData },
        ],
      },
      1,
      async ([data]) => [{
        source: ((data as { objects: Array<{ text?: string }> }).objects[1].text ?? ''),
      }],
      () => false,
    );

    expect(canvas.objects).toEqual([
      { id: 'distance', source: '3.00 m' },
      { id: 'area', source: '9.00 m²' },
    ]);
  });
});