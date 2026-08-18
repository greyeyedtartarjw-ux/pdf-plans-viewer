import { describe, it, expect } from 'vitest';
import { deduplicatePoints, calculateArea, calculateDistance, formatMeasurement } from '../measurementUtils';

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
