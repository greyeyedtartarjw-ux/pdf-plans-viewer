import { Scale } from '../types';

/**
 * Resolve the effective point for an area-polygon click.
 *
 * When the cursor is within `snapThresholdSceneUnits` of `firstPt` AND at
 * least `minPointsForClose` points have already been placed, the raw pointer
 * is snapped to `firstPt` exactly so the polygon closes cleanly.
 *
 * This pure function is the single source-of-truth for snap resolution; both
 * the live-preview (handleMouseMove) and the click-accumulation
 * (handleMouseDown) paths must call it so the stored coordinate matches the
 * visual feedback.
 */
export const resolveSnapPoint = (
  pointer: { x: number; y: number },
  firstPt: { x: number; y: number },
  snapThresholdSceneUnits: number,
  placedPointCount: number,
  minPointsForClose = 3,
): { x: number; y: number } => {
  if (placedPointCount < minPointsForClose) return pointer;
  const dx = pointer.x - firstPt.x;
  const dy = pointer.y - firstPt.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist <= snapThresholdSceneUnits ? firstPt : pointer;
};

/**
 * Deduplicate consecutive points that are within `tolerance` canvas pixels.
 * This makes the double-click close logic robust regardless of how many
 * duplicate mousedown events fire before the dblclick event.
 */
export const deduplicatePoints = (
  pts: { x: number; y: number }[],
  tolerance = 4,
): { x: number; y: number }[] =>
  pts.filter((pt, i) => {
    if (i === 0) return true;
    const prev = pts[i - 1];
    return Math.abs(pt.x - prev.x) > tolerance || Math.abs(pt.y - prev.y) > tolerance;
  });

export const calculateDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

export const calculateArea = (points: { x: number; y: number }[]): number => {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
};

export const formatMeasurement = (pixels: number, scale: Scale, isArea: boolean = false): { value: number; unit: string; label: string } => {
  if (!scale.set || scale.pixelsPerUnit === 0) {
    return {
      value: pixels,
      unit: 'px' + (isArea ? '²' : ''),
      label: `${pixels.toFixed(2)} px${isArea ? '²' : ''}`
    };
  }

  if (isArea) {
    const realArea = pixels / Math.pow(scale.pixelsPerUnit, 2);
    return {
      value: realArea,
      unit: scale.realWorldUnit + '²',
      label: `${realArea.toFixed(2)} ${scale.realWorldUnit}²`
    };
  } else {
    const realDistance = pixels / scale.pixelsPerUnit;
    return {
      value: realDistance,
      unit: scale.realWorldUnit,
      label: `${realDistance.toFixed(2)} ${scale.realWorldUnit}`
    };
  }
};
