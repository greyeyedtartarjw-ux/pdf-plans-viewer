export interface PdfPoint {
  x: number;
  y: number;
}

/**
 * Converts a measurement from the temporary, device-sized canvas into the
 * PDF.js viewport coordinate system at scale=1. That coordinate system is
 * shared by the web viewer, and does not change when a phone rotates.
 */
export function viewportToPdfRatio(
  viewportWidth: number,
  naturalPageWidth: number,
): number {
  if (viewportWidth <= 0 || naturalPageWidth <= 0) {
    return 0;
  }
  return naturalPageWidth / viewportWidth;
}

export function toPdfDistance(
  viewportDistance: number,
  viewportWidth: number,
  naturalPageWidth: number,
): number {
  return viewportDistance * viewportToPdfRatio(viewportWidth, naturalPageWidth);
}

export function toPdfArea(
  viewportArea: number,
  viewportWidth: number,
  naturalPageWidth: number,
): number {
  const ratio = viewportToPdfRatio(viewportWidth, naturalPageWidth);
  return viewportArea * ratio * ratio;
}

/** Maps persisted source-canvas points to the active mobile canvas. */
export function scalePointsForViewport(
  points: PdfPoint[],
  sourceWidth: number,
  activeWidth: number,
): PdfPoint[] {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(activeWidth) ||
    sourceWidth <= 0 ||
    activeWidth <= 0
  ) {
    return points;
  }
  const ratio = activeWidth / sourceWidth;
  return points.map((point) => ({ x: point.x * ratio, y: point.y * ratio }));
}

/**
 * Mobile measurements save the source canvas width, while web-created Fabric
 * data does not. Preserve the latter exactly as the mobile viewer did before
 * viewport-rescaling was introduced.
 */
export function pointsForMobileOverlay(
  points: PdfPoint[],
  fabricData: Record<string, unknown> | undefined,
  activeWidth: number,
): PdfPoint[] {
  return scalePointsForViewport(
    points,
    Number(fabricData?.canvasWidth),
    activeWidth,
  );
}