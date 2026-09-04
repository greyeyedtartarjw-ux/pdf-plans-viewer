export interface SavedFabricItem {
  id: string;
  data: unknown;
}

export interface FabricCanvasForRestore {
  clear(): unknown;
  add(object: unknown): unknown;
  renderAll(): unknown;
}

type EnlivenObjects = (serialized: unknown[]) => Promise<unknown[]>;
export type LegacyZoomResolver = (
  item: SavedFabricItem,
  pageNumber: number,
  currentZoom: number,
) => number;

export function getViewerZoom(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const viewerZoom = (data as { viewerZoom?: unknown }).viewerZoom;
  return typeof viewerZoom === 'number' && Number.isFinite(viewerZoom) && viewerZoom > 0
    ? viewerZoom
    : undefined;
}

export function hasExplicitViewerZoom(data: unknown): boolean {
  return getViewerZoom(data) !== undefined;
}

/**
 * Legacy objects do not contain enough information to reconstruct the zoom at
 * which they were authored. Preserve their placement at the first zoom where
 * they are restored, then use that stable baseline for later zoom changes.
 */
export function createLegacyZoomResolver(): LegacyZoomResolver {
  const sourceZoomByItem = new Map<string, number>();
  return (item, pageNumber, currentZoom) => {
    const key = `${pageNumber}:${item.id}`;
    const sourceZoom = sourceZoomByItem.get(key);
    if (sourceZoom !== undefined) return sourceZoom;
    sourceZoomByItem.set(key, currentZoom);
    return currentZoom;
  };
}

/**
 * Rebuild the saved page objects after a document snapshot is loaded. The
 * caller supplies cancellation so an older async Fabric decode cannot paint
 * over a newer page, reconnect hydration, or a newly opened PDF.
 */
export async function rebuildFabricPage(
  canvas: FabricCanvasForRestore,
  annotations: Record<number, SavedFabricItem[]>,
  measurements: Record<number, SavedFabricItem[]>,
  pageNumber: number,
  enlivenObjects: EnlivenObjects,
  isCancelled: () => boolean,
  zoom = 1,
  resolveLegacyZoom: LegacyZoomResolver = (_item, _pageNumber, currentZoom) => currentZoom,
): Promise<boolean> {
  canvas.clear();
  const items = [
    ...(annotations[pageNumber] ?? []),
    ...(measurements[pageNumber] ?? []),
  ];

  const decoded = await Promise.allSettled(
    items.map(async (item) => ({
      id: item.id,
      objects: await enlivenObjects([item.data]),
    })),
  );

  if (isCancelled()) return false;

  for (const result of decoded) {
    if (result.status !== 'fulfilled') continue;
    for (const object of result.value.objects) {
      const item = items.find((candidate) => candidate.id === result.value.id);
      if (!item) continue;
      const sourceZoom = getViewerZoom(item.data)
        ?? resolveLegacyZoom(item, pageNumber, zoom);
      const ratio = zoom / sourceZoom;
      if (ratio !== 1 && object && typeof object === 'object') {
        const scaledObject = object as {
          left?: number;
          top?: number;
          scaleX?: number;
          scaleY?: number;
          set?: (properties: Record<string, number>) => void;
        };
        scaledObject.set?.({
          ...(typeof scaledObject.left === 'number' ? { left: scaledObject.left * ratio } : {}),
          ...(typeof scaledObject.top === 'number' ? { top: scaledObject.top * ratio } : {}),
          ...(typeof scaledObject.scaleX === 'number' ? { scaleX: scaledObject.scaleX * ratio } : {}),
          ...(typeof scaledObject.scaleY === 'number' ? { scaleY: scaledObject.scaleY * ratio } : {}),
        });
      }
      (object as { id?: string }).id = result.value.id;
      canvas.add(object);
    }
  }
  canvas.renderAll();
  return true;
}