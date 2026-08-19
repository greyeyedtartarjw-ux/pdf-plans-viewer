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
      (object as { id?: string }).id = result.value.id;
      canvas.add(object);
    }
  }
  canvas.renderAll();
  return true;
}