import { describe, it, expect } from 'vitest';
import {
  deduplicatePoints,
  calculateArea,
  calculateDistance,
  formatMeasurement,
  recalculatePixelMeasurement,
  resolveSnapPoint,
  updateFabricMeasurementLabel,
} from '../measurementUtils';

// ---------------------------------------------------------------------------
// deduplicatePoints
// ---------------------------------------------------------------------------

describe('deduplicatePoints', () => {
  it('returns a single point unchanged', () => {
    const pts = [{ x: 10, y: 20 }];
    expect(deduplicatePoints(pts)).toEqual([{ x: 10, y: 20 }]);
  });

  it('removes an exact duplicate consecutive point', () => {
    const pts = [
      { x: 10, y: 20 },
      { x: 10, y: 20 },
      { x: 50, y: 60 },
    ];
    expect(deduplicatePoints(pts)).toEqual([
      { x: 10, y: 20 },
      { x: 50, y: 60 },
    ]);
  });

  it('removes near-duplicate consecutive points within default tolerance (4 px)', () => {
    // Both dx and dy are within tolerance — should be dropped
    const pts = [
      { x: 100, y: 200 },
      { x: 103, y: 203 }, // dx=3, dy=3 — within ≤4 on both axes
      { x: 200, y: 300 },
    ];
    expect(deduplicatePoints(pts)).toEqual([
      { x: 100, y: 200 },
      { x: 200, y: 300 },
    ]);
  });

  it('keeps a point whose x differs by more than tolerance even if y is close', () => {
    const pts = [
      { x: 100, y: 200 },
      { x: 105, y: 201 }, // dx=5 > 4, so kept
    ];
    expect(deduplicatePoints(pts)).toHaveLength(2);
  });

  it('keeps a point whose y differs by more than tolerance even if x is close', () => {
    const pts = [
      { x: 100, y: 200 },
      { x: 101, y: 206 }, // dy=6 > 4, so kept
    ];
    expect(deduplicatePoints(pts)).toHaveLength(2);
  });

  it('removes multiple consecutive near-duplicates (double-click scenario)', () => {
    // dblclick fires two mousedown events at essentially the same position
    const pts = [
      { x: 10, y: 10 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
      { x: 101, y: 100 }, // near-dup of previous — gets removed
      { x: 101, y: 101 }, // near-dup of the filtered-out point; prev is now (100,100), dy=1 dx=1 — removed
    ];
    const result = deduplicatePoints(pts);
    expect(result).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
    ]);
  });

  it('respects a custom tolerance value', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 8, y: 8 }, // within tolerance=10 — removed
      { x: 20, y: 20 },
    ];
    expect(deduplicatePoints(pts, 10)).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 20 },
    ]);
  });

  it('keeps legitimately distinct consecutive points that are close but outside tolerance', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0 }, // dx=5 > 4, kept
      { x: 10, y: 0 }, // dx=5 > 4, kept
    ];
    expect(deduplicatePoints(pts)).toHaveLength(3);
  });

  it('handles an empty array', () => {
    expect(deduplicatePoints([])).toEqual([]);
  });

  it('does NOT deduplicate non-consecutive duplicate points', () => {
    // Only consecutive pairs are compared; identical points with a different
    // point in between are both retained.
    const pts = [
      { x: 10, y: 10 },
      { x: 50, y: 50 },
      { x: 10, y: 10 }, // same as first but not consecutive — kept
    ];
    expect(deduplicatePoints(pts)).toHaveLength(3);
  });
});

describe('recalculatePixelMeasurement', () => {
  const scale = {
    set: true,
    pixelsPerUnit: 10,
    unit: 'px',
    realWorldUnit: 'ft',
    scaleKind: 'preset' as const,
    presetRatio: '1/4' as const,
    calibrationDistanceFeet: null,
  };

  it('converts an existing pixel distance to the new real-world scale', () => {
    expect(recalculatePixelMeasurement({
      id: 'distance-1',
      pageNumber: 1,
      type: 'distance',
      label: '30.00 px',
      realWorldValue: 30,
      unit: 'px',
      points: [],
      data: {},
    }, scale)).toEqual({
      label: '3.00 ft',
      realWorldValue: 3,
      unit: 'ft',
    });
  });

  it('converts an existing pixel area using the squared scale', () => {
    expect(recalculatePixelMeasurement({
      id: 'area-1',
      pageNumber: 1,
      type: 'area',
      label: '900.00 px²',
      realWorldValue: 900,
      unit: 'px²',
      points: [],
      data: {},
    }, scale)).toEqual({
      label: '9.00 ft²',
      realWorldValue: 9,
      unit: 'ft²',
    });
  });

  it('updates the serialized Fabric text while preserving the shape data', () => {
    const data = {
      type: 'Group',
      objects: [
        { type: 'Line', stroke: '#f00' },
        { type: 'Text', text: '900.00 px²', left: 5 },
      ],
    };

    expect(updateFabricMeasurementLabel(data, '9.00 m²')).toEqual({
      type: 'Group',
      objects: [
        { type: 'Line', stroke: '#f00' },
        { type: 'Text', text: '9.00 m²', left: 5 },
      ],
    });
    expect(data.objects[1].text).toBe('900.00 px²');
  });
});

// ---------------------------------------------------------------------------
// calculateArea (Shoelace / Gauss formula)
// ---------------------------------------------------------------------------

describe('calculateArea', () => {
  it('returns 0 for fewer than 3 points', () => {
    expect(calculateArea([])).toBe(0);
    expect(calculateArea([{ x: 0, y: 0 }])).toBe(0);
    expect(calculateArea([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(0);
  });

  it('calculates the area of a unit square', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(calculateArea(square)).toBeCloseTo(1, 10);
  });

  it('calculates the area of a known right triangle', () => {
    // Right triangle with legs 6 and 4 → area = 12
    const tri = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 4 },
    ];
    expect(calculateArea(tri)).toBeCloseTo(12, 10);
  });

  it('calculates the area of a larger rectangle', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(calculateArea(rect)).toBeCloseTo(5000, 5);
  });

  it('returns 0 for collinear points (degenerate zero-area polygon)', () => {
    const collinear = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
    ];
    expect(calculateArea(collinear)).toBeCloseTo(0, 10);
  });

  it('returns 0 for all points at the same location', () => {
    const same = [
      { x: 7, y: 7 },
      { x: 7, y: 7 },
      { x: 7, y: 7 },
    ];
    expect(calculateArea(same)).toBeCloseTo(0, 10);
  });

  it('gives the same result regardless of winding order (CW vs CCW)', () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const cw = [...ccw].reverse();
    expect(calculateArea(ccw)).toBeCloseTo(calculateArea(cw), 10);
  });

  it('handles a large pixel area without overflow', () => {
    // Simulating a ~1000×1500 px canvas region
    const large = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1500 },
      { x: 0, y: 1500 },
    ];
    expect(calculateArea(large)).toBeCloseTo(1_500_000, 0);
  });
});

// ---------------------------------------------------------------------------
// calculateDistance
// ---------------------------------------------------------------------------

describe('calculateDistance', () => {
  it('returns 0 for identical points', () => {
    expect(calculateDistance({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('calculates a horizontal distance', () => {
    expect(calculateDistance({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(10);
  });

  it('calculates a vertical distance', () => {
    expect(calculateDistance({ x: 0, y: 0 }, { x: 0, y: 7 })).toBeCloseTo(7);
  });

  it('calculates the hypotenuse of a 3-4-5 right triangle', () => {
    expect(calculateDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });
});

// ---------------------------------------------------------------------------
// formatMeasurement
// ---------------------------------------------------------------------------

const unsetScale = { set: false, pixelsPerUnit: 0, unit: 'px', realWorldUnit: 'm' };
const setScale = { set: true, pixelsPerUnit: 50, unit: 'px', realWorldUnit: 'm' };

describe('formatMeasurement — no scale set', () => {
  it('returns raw pixels for a distance', () => {
    const result = formatMeasurement(120, unsetScale, false);
    expect(result.unit).toBe('px');
    expect(result.value).toBeCloseTo(120);
    expect(result.label).toBe('120.00 px');
  });

  it('returns raw pixels² for an area', () => {
    const result = formatMeasurement(400, unsetScale, true);
    expect(result.unit).toBe('px²');
    expect(result.value).toBeCloseTo(400);
    expect(result.label).toBe('400.00 px²');
  });

  it('also returns raw pixels when pixelsPerUnit is 0 even if set=true', () => {
    const zeroScale = { set: true, pixelsPerUnit: 0, unit: 'px', realWorldUnit: 'm' };
    const result = formatMeasurement(50, zeroScale, false);
    expect(result.unit).toBe('px');
  });
});

// ---------------------------------------------------------------------------
// Snap → deduplicatePoints → calculateArea pipeline
//
// The area-drawing tool snaps the closing click to the first point when the
// cursor is within the snap radius. A double-click fires two mousedown events,
// so the raw `points` array typically contains one or two near-duplicate
// closing entries. This suite tests the full pipeline:
//   snap (coordinate adjustment) → deduplicatePoints → calculateArea
// ---------------------------------------------------------------------------

describe('resolveSnapPoint', () => {
  const A = { x: 0, y: 0 };
  const threshold = 12;
  const minPts = 3; // default minPointsForClose

  it('snaps to first point when within threshold and enough points placed', () => {
    const ptr = { x: 3, y: 2 }; // ~3.6 px from A
    expect(resolveSnapPoint(ptr, A, threshold, minPts)).toBe(A);
  });

  it('does NOT snap when distance exceeds threshold', () => {
    const ptr = { x: 20, y: 0 }; // 20 px from A
    expect(resolveSnapPoint(ptr, A, threshold, minPts)).toEqual(ptr);
  });

  it('does NOT snap when fewer than minPointsForClose points are placed', () => {
    // Only 2 points placed — cannot close yet
    const ptr = { x: 1, y: 1 }; // well within threshold
    expect(resolveSnapPoint(ptr, A, threshold, 2)).toEqual(ptr);
  });

  it('snaps exactly on the threshold boundary', () => {
    // Point exactly 12 px away should snap (≤ threshold)
    const ptr = { x: 12, y: 0 };
    expect(resolveSnapPoint(ptr, A, threshold, minPts)).toBe(A);
  });

  it('does not snap when one pixel beyond the threshold', () => {
    const ptr = { x: 13, y: 0 };
    expect(resolveSnapPoint(ptr, A, threshold, minPts)).toEqual(ptr);
  });

  it('respects a custom minPointsForClose', () => {
    const ptr = { x: 2, y: 0 }; // within threshold
    // With minPointsForClose=4 and only 3 placed, no snap
    expect(resolveSnapPoint(ptr, A, threshold, 3, 4)).toEqual(ptr);
    // With minPointsForClose=3 and 3 placed, snap fires
    expect(resolveSnapPoint(ptr, A, threshold, 3, 3)).toBe(A);
  });
});

describe('resolveSnapPoint → deduplicatePoints → calculateArea pipeline', () => {
  // ── Context ───────────────────────────────────────────────────────────────
  // PDFPageViewer appends points to `points.current` on every mousedown.
  // A double-click fires two mousedown events at roughly the same position,
  // so the array ends with 1-2 near-duplicate closing entries.
  // resolveSnapPoint is called in handleMouseDown to replace those entries
  // with the exact first-point coordinate when within the snap radius.
  // Then handleDblClick runs deduplicatePoints → calculateArea.

  it('snapped closing click (within radius) deduplicates cleanly for a triangle', () => {
    const A = { x: 0, y: 0 };
    const B = { x: 100, y: 0 };
    const C = { x: 0, y: 100 };
    const snapThreshold = 12;

    // Raw closing click is 3 px from A — within snap radius; both dblclick
    // mousedown events resolve to A via resolveSnapPoint.
    const rawClose = { x: 3, y: 2 };
    const resolved1 = resolveSnapPoint(rawClose, A, snapThreshold, 3 /* points so far: A,B,C */);
    const resolved2 = resolveSnapPoint(rawClose, A, snapThreshold, 4 /* after first close appended */);

    expect(resolved1).toBe(A);
    expect(resolved2).toBe(A);

    // Simulated points.current after both mousedown events
    const rawPoints = [A, B, C, resolved1, resolved2];
    const deduped = deduplicatePoints(rawPoints);

    // Both trailing A entries collapse: result is [A, B, C, A] or [A, B, C]
    expect(deduped.length).toBeGreaterThanOrEqual(3);
    expect(calculateArea(deduped)).toBeCloseTo(5000, 1); // 0.5 × 100 × 100
  });

  it('snap rescues a closing click just outside dedup tolerance, keeping area correct', () => {
    // Without snap: the closing click (5 px from A) is beyond the 4 px dedup
    // tolerance and survives deduplication as a spurious 4th vertex, distorting
    // the measured area.
    // With snap: resolveSnapPoint pulls it to A, dedup removes the duplicate,
    // and the area equals the ideal triangle.
    const A = { x: 0, y: 0 };
    const B = { x: 200, y: 0 };
    const C = { x: 0, y: 200 };
    const snapThreshold = 12;
    const dedupTolerance = 4;

    const rawClose = { x: 5, y: 0 }; // 5 px from A: inside snap, outside dedup

    // ── Without snap ──
    const rawNoSnap = [A, B, C, rawClose, rawClose];
    const areaNoSnap = calculateArea(deduplicatePoints(rawNoSnap, dedupTolerance));

    // ── With snap (production path) ──
    const c1 = resolveSnapPoint(rawClose, A, snapThreshold, 3);
    const c2 = resolveSnapPoint(rawClose, A, snapThreshold, 4);
    const rawSnap = [A, B, C, c1, c2];
    const areaSnap = calculateArea(deduplicatePoints(rawSnap, dedupTolerance));

    expect(areaSnap).toBeCloseTo(20000, 1); // correct: 0.5 × 200 × 200
    expect(Math.abs(areaNoSnap - areaSnap)).toBeGreaterThan(0); // snap changed the result
  });

  it('closing click outside snap radius is kept as a spurious vertex and corrupts area', () => {
    // Documents the negative case: no snap fires, spurious vertex persists.
    const A = { x: 0, y: 0 };
    const B = { x: 100, y: 0 };
    const C = { x: 0, y: 100 };
    const snapThreshold = 12;

    const rawClose = { x: 20, y: 0 }; // 20 px from A — beyond snap radius
    const resolved = resolveSnapPoint(rawClose, A, snapThreshold, 3);

    expect(resolved).toEqual(rawClose); // snap did NOT fire

    const pts = [A, B, C, resolved];
    expect(calculateArea(deduplicatePoints(pts))).not.toBeCloseTo(5000, 0);
  });

  it('multiple snapped closing events all collapse via deduplication (square)', () => {
    // Even three rapid mousedown events at the same closing position all
    // snap to A and are deduped down to one trailing entry.
    const A = { x: 50, y: 50 };
    const B = { x: 150, y: 50 };
    const C = { x: 150, y: 150 };
    const D = { x: 50, y: 150 };
    const snapThreshold = 12;

    const rawClose = { x: 51, y: 50 }; // 1 px from A
    const c1 = resolveSnapPoint(rawClose, A, snapThreshold, 4);
    const c2 = resolveSnapPoint(rawClose, A, snapThreshold, 5);
    const c3 = resolveSnapPoint(rawClose, A, snapThreshold, 6);

    expect(c1).toBe(A);

    const rawPoints = [A, B, C, D, c1, c2, c3];
    const deduped = deduplicatePoints(rawPoints);

    // D=(50,150) → A=(50,50): dy=100 > 4, so trailing A is kept → 5 points
    expect(deduped.length).toBe(5);
    expect(calculateArea(deduped)).toBeCloseTo(10000, 1); // 100×100 square
  });

  it('snap threshold scales correctly with zoom', () => {
    // At zoom=2 the snap threshold in scene units is 12/2 = 6.
    const zoom = 2;
    const thresholdScene = 12 / zoom;

    const A = { x: 0, y: 0 };
    const B = { x: 100, y: 0 };
    const C = { x: 0, y: 100 };

    const closeIn  = { x: 5, y: 0 }; // 5 scene-px: within threshold
    const closeOut = { x: 7, y: 0 }; // 7 scene-px: outside threshold

    expect(resolveSnapPoint(closeIn,  A, thresholdScene, 3)).toBe(A);
    expect(resolveSnapPoint(closeOut, A, thresholdScene, 3)).toEqual(closeOut);

    // Snapped → clean triangle
    const c1 = resolveSnapPoint(closeIn, A, thresholdScene, 3);
    const c2 = resolveSnapPoint(closeIn, A, thresholdScene, 4);
    expect(calculateArea(deduplicatePoints([A, B, C, c1, c2]))).toBeCloseTo(5000, 1);

    // Unsnapped → spurious vertex
    const u = resolveSnapPoint(closeOut, A, thresholdScene, 3);
    expect(calculateArea(deduplicatePoints([A, B, C, u]))).not.toBeCloseTo(5000, 0);
  });

  it('closing vertex equal to first point is mathematically inert in Shoelace', () => {
    // Whether dedup retains or drops the trailing closing vertex (= first point),
    // calculateArea must return the same value.
    const A = { x: 10, y: 10 };
    const B = { x: 110, y: 10 };
    const C = { x: 10, y: 110 };

    expect(calculateArea([A, B, C, A])).toBeCloseTo(calculateArea([A, B, C]), 10);
  });
});

describe('formatMeasurement — scale set', () => {
  it('converts distance pixels to real-world units', () => {
    // 100 px / 50 px-per-m = 2 m
    const result = formatMeasurement(100, setScale, false);
    expect(result.value).toBeCloseTo(2);
    expect(result.unit).toBe('m');
    expect(result.label).toBe('2.00 m');
  });

  it('converts area pixels² to real-world units²', () => {
    // 2500 px² / (50²) px²-per-m² = 1 m²
    const result = formatMeasurement(2500, setScale, true);
    expect(result.value).toBeCloseTo(1);
    expect(result.unit).toBe('m²');
    expect(result.label).toBe('1.00 m²');
  });

  it('labels include the correct unit suffix', () => {
    const dist = formatMeasurement(50, setScale, false);
    const area = formatMeasurement(2500, setScale, true);
    expect(dist.label).toMatch(/m$/);
    expect(area.label).toMatch(/m²$/);
  });

  it('handles fractional real-world values rounded to 2 dp', () => {
    // 75 px / 50 px-per-m = 1.5 m
    const result = formatMeasurement(75, setScale, false);
    expect(result.label).toBe('1.50 m');
  });
});
