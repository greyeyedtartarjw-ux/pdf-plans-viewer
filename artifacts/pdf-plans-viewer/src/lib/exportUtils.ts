import type { Annotation, Measurement, Scale } from '../types';

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
 * Export the full backup (annotations + measurements + scale) as a JSON file.
 * Works completely offline.
 */
export function exportBackupJSON(
  annotations: Record<number, Annotation[]>,
  measurements: Record<number, Measurement[]>,
  scale: Scale,
  documentName: string | null | undefined
) {
  const payload = {
    exportedAt: new Date().toISOString(),
    document: documentName ?? null,
    scale,
    annotations,
    measurements,
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(blob, `annotations-backup-${slugify(documentName)}-${ts}.json`);
}
