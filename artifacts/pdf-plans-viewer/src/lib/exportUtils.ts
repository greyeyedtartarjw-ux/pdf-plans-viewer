import type { Annotation, Measurement, Scale } from '../types';

export interface BackupData {
  exportedAt: string;
  document: string | null;
  scales: Record<number, Scale>;
  annotations: Record<number, Annotation[]>;
  measurements: Record<number, Measurement[]>;
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

const annotationTypes = new Set(['highlight', 'note', 'text']);
const measurementTypes = new Set(['distance', 'area']);
const presetRatios = new Set(['1/8', '1/4', '3/6', '3/4', '1']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePageRecords<T>(
  value: unknown,
  label: string,
  totalPages: number,
  parseItem: (item: unknown, page: number, index: number) => T,
): Record<number, T[]> {
  if (!isRecord(value)) throw new BackupValidationError(`The backup's ${label} section is missing or invalid.`);

  const result: Record<number, T[]> = {};
  for (const [pageKey, items] of Object.entries(value)) {
    const page = Number(pageKey);
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      throw new BackupValidationError(`The backup contains ${label} for invalid page ${pageKey}.`);
    }
    if (!Array.isArray(items)) {
      throw new BackupValidationError(`The backup's ${label} for page ${page} must be a list.`);
    }
    result[page] = items.map((item, index) => parseItem(item, page, index));
  }
  return result;
}

function parseScale(value: unknown, page: number): Scale {
  if (!isRecord(value)) throw new BackupValidationError(`The scale for page ${page} is invalid.`);
  const validPreset = value.presetRatio === null || presetRatios.has(String(value.presetRatio));
  const validCalibration = value.calibrationDistanceFeet === null
    || (typeof value.calibrationDistanceFeet === 'number' && Number.isFinite(value.calibrationDistanceFeet));
  if (
    typeof value.set !== 'boolean'
    || typeof value.pixelsPerUnit !== 'number'
    || !Number.isFinite(value.pixelsPerUnit)
    || value.pixelsPerUnit <= 0
    || value.unit !== 'px'
    || value.realWorldUnit !== 'ft'
    || (value.scaleKind !== 'preset' && value.scaleKind !== 'custom')
    || !validPreset
    || !validCalibration
  ) {
    throw new BackupValidationError(`The scale for page ${page} is invalid.`);
  }
  return value as unknown as Scale;
}

/**
 * Parse and validate an exported backup before any viewer state is changed.
 */
export function parseBackupJSON(
  text: string,
  expectedDocument: string,
  totalPages: number,
): BackupData {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupValidationError('This file is not valid JSON.');
  }
  if (!isRecord(value)) throw new BackupValidationError('This file is not a PDF Plans Viewer backup.');
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt))) {
    throw new BackupValidationError('This backup has an invalid export date.');
  }
  if (value.document !== null && typeof value.document !== 'string') {
    throw new BackupValidationError('This backup has invalid document information.');
  }
  if (value.document !== expectedDocument) {
    throw new BackupValidationError(
      `This backup is for "${value.document ?? 'an unnamed document'}", not "${expectedDocument}".`,
    );
  }

  if (!isRecord(value.scales)) throw new BackupValidationError("The backup's scales section is missing or invalid.");
  const scales: Record<number, Scale> = {};
  for (const [pageKey, scale] of Object.entries(value.scales)) {
    const page = Number(pageKey);
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      throw new BackupValidationError(`The backup contains a scale for invalid page ${pageKey}.`);
    }
    scales[page] = parseScale(scale, page);
  }

  const ids = new Set<string>();
  const annotations = parsePageRecords(value.annotations, 'annotations', totalPages, (item, page, index) => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || item.id.length === 0
      || item.pageNumber !== page
      || !annotationTypes.has(String(item.type))
      || !isRecord(item.data)
      || typeof item.data.type !== 'string'
      || item.data.type.length === 0
    ) {
      throw new BackupValidationError(`Annotation ${index + 1} on page ${page} is invalid.`);
    }
    if (ids.has(item.id)) throw new BackupValidationError(`The backup contains duplicate item ID "${item.id}".`);
    ids.add(item.id);
    return item as unknown as Annotation;
  });
  const measurements = parsePageRecords(value.measurements, 'measurements', totalPages, (item, page, index) => {
    const validPoints = isRecord(item)
      && Array.isArray(item.points)
      && item.points.every(point => (
        isRecord(point)
        && typeof point.x === 'number'
        && Number.isFinite(point.x)
        && typeof point.y === 'number'
        && Number.isFinite(point.y)
      ));
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || item.id.length === 0
      || item.pageNumber !== page
      || !measurementTypes.has(String(item.type))
      || typeof item.label !== 'string'
      || typeof item.realWorldValue !== 'number'
      || !Number.isFinite(item.realWorldValue)
      || typeof item.unit !== 'string'
      || !validPoints
      || !isRecord(item.data)
      || typeof item.data.type !== 'string'
      || item.data.type.length === 0
    ) {
      throw new BackupValidationError(`Measurement ${index + 1} on page ${page} is invalid.`);
    }
    if (ids.has(item.id)) throw new BackupValidationError(`The backup contains duplicate item ID "${item.id}".`);
    ids.add(item.id);
    return item as unknown as Measurement;
  });

  return {
    exportedAt: value.exportedAt,
    document: value.document,
    scales,
    annotations,
    measurements,
  };
}

/** Trigger a file download in the browser without any server round-trip. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(name: string | null | undefined) {
  return (name || 'export')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Export all measurements across all pages as a CSV file.
 * Columns: page, type, label, value, unit
 */
export function exportMeasurementsCSV(
  measurements: Record<number, Measurement[]>,
  documentName: string | null | undefined
) {
  const rows: string[] = [
    // header
    ['Page', 'Type', 'Label', 'Value', 'Unit'].join(','),
  ];

  const pages = Object.keys(measurements)
    .map(Number)
    .sort((a, b) => a - b);

  for (const page of pages) {
    for (const m of measurements[page] || []) {
      const value =
        m.realWorldValue !== undefined && m.realWorldValue !== null
          ? String(m.realWorldValue)
          : '';
      const unit = m.unit ?? '';
      const label = m.label ?? '';
      // Escape fields that contain commas or quotes
      const escape = (s: string) =>
        /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      rows.push(
        [page, escape(m.type), escape(label), escape(value), escape(unit)].join(',')
      );
    }
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(blob, `measurements-${slugify(documentName)}-${ts}.csv`);
}

/**
 * Export the full backup (annotations + measurements + page scales) as a JSON file.
 * Works completely offline.
 */
export function exportBackupJSON(
  annotations: Record<number, Annotation[]>,
  measurements: Record<number, Measurement[]>,
  scales: Record<number, Scale>,
  documentName: string | null | undefined
) {
  const payload = {
    exportedAt: new Date().toISOString(),
    document: documentName ?? null,
    scales,
    annotations,
    measurements,
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(blob, `annotations-backup-${slugify(documentName)}-${ts}.json`);
}
