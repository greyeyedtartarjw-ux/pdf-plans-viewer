import { describe, expect, it } from 'vitest';
import {
  pointsForMobileOverlay,
  scalePointsForViewport,
  toPdfArea,
  toPdfDistance,
} from '../../../../plans-mobile/lib/pdfCoordinates';

describe('mobile PDF coordinate conversion', () => {
  const naturalPageWidth = 612;

  it('produces the same shared scale as a web viewer at a different zoom', () => {
    // Mobile canvas: 390px wide; the known line spans half the PDF page.
    const mobilePageDistance = toPdfDistance(195, 390, naturalPageWidth);
    const pixelsPerMetre = mobilePageDistance / 3;

    // The web viewer measures the same 306 PDF-unit line at 50% zoom and
    // divides its Fabric canvas distance by zoom before applying the scale.
    const webPageDistance = 153 / 0.5;
    expect(pixelsPerMetre).toBe(102);
    expect(webPageDistance / pixelsPerMetre).toBe(3);
  });

  it('keeps distance results stable after the phone rotates', () => {
    const pixelsPerMetre = toPdfDistance(195, 390, naturalPageWidth) / 3;

    // Landscape canvas is wider, so the same PDF span covers more viewport px.
    const landscapePageDistance = toPdfDistance(422, 844, naturalPageWidth);
    expect(landscapePageDistance / pixelsPerMetre).toBe(3);
  });

  it('squares the viewport ratio for area measurements', () => {
    // A 100px × 50px viewport rectangle on a 306px-wide canvas represents
    // a 200 × 100 PDF-unit rectangle on a 612px-wide PDF page.
    expect(toPdfArea(5_000, 306, naturalPageWidth)).toBe(20_000);
  });

  it('rescales persisted mobile overlay points for the active viewport', () => {
    expect(scalePointsForViewport([{ x: 195, y: 100 }], 390, 780)).toEqual([
      { x: 390, y: 200 },
    ]);
  });

  it('preserves web-created measurement points without mobile canvas metadata', () => {
    const webCreatedPoints = [{ x: 120, y: 80 }, { x: 240, y: 80 }];

    // Web Fabric data has no canvasWidth. This is the exact payload handed
    // to the mobile WebView overlay, so no NaN coordinates can be introduced.
    expect(pointsForMobileOverlay(webCreatedPoints, { type: 'group' }, 390)).toEqual(
      webCreatedPoints,
    );
  });

  it('preserves overlay points when canvas metadata is invalid', () => {
    const points = [{ x: 120, y: 80 }];
    expect(scalePointsForViewport(points, Number.NaN, 390)).toEqual(points);
    expect(scalePointsForViewport(points, Number.POSITIVE_INFINITY, 390)).toEqual(points);
  });
});