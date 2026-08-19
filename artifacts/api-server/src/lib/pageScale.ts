import type { DocumentScale } from "@workspace/db";

const legacyUnitToFeet: Record<string, number> = {
  ft: 1,
  m: 0.3048,
  cm: 30.48,
  mm: 304.8,
  in: 12,
};

/**
 * Treat pre-page-scale rows as custom page-one feet scales while preserving
 * their physical ratio. Publish handles schema changes, so this keeps a
 * legacy row usable until a user saves it again through the new API.
 */
export function normalizePageScale(scale: DocumentScale): DocumentScale {
  if (!scale.isSet) {
    return {
      ...scale,
      realWorldUnit: "ft",
      scaleKind: "custom",
      presetRatio: null,
      calibrationDistanceFeet: null,
    };
  }

  const multiplier = legacyUnitToFeet[scale.realWorldUnit];
  const hasLegacyCustomMetadata =
    scale.scaleKind === "custom" && scale.calibrationDistanceFeet === null;
  if (multiplier === 1 && !hasLegacyCustomMetadata) return scale;

  return {
    ...scale,
    pixelsPerUnit: multiplier ? scale.pixelsPerUnit * multiplier : scale.pixelsPerUnit,
    realWorldUnit: "ft",
    scaleKind: "custom",
    presetRatio: null,
    calibrationDistanceFeet: scale.calibrationDistanceFeet ?? 1,
  };
}