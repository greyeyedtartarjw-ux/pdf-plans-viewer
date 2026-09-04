import { DEFAULT_SCALE, type Annotation, type Measurement, type Scale } from '../types';
import type { BackupData } from './exportUtils';
import type { PendingOp } from './pendingQueue';

interface CurrentBackupState {
  annotations: Record<number, Annotation[]>;
  measurements: Record<number, Measurement[]>;
  scales: Record<number, Scale>;
}

/**
 * Build an authoritative, replayable restore transaction. Deletes come first
 * so imported items with existing IDs are recreated with their backup payload.
 */
export function createBackupRestoreOps(
  documentId: number,
  current: CurrentBackupState,
  backup: BackupData,
  nextSequence: () => number,
): PendingOp[] {
  const timestamp = Date.now();
  const operations: PendingOp[] = [];

  for (const annotation of Object.values(current.annotations).flat()) {
    operations.push({
      opType: 'delete_annotation',
      documentId,
      id: annotation.id,
      timestamp,
      sequence: nextSequence(),
    });
  }
  for (const measurement of Object.values(current.measurements).flat()) {
    operations.push({
      opType: 'delete_measurement',
      documentId,
      id: measurement.id,
      timestamp,
      sequence: nextSequence(),
    });
  }
  for (const annotation of Object.values(backup.annotations).flat()) {
    operations.push({
      opType: 'create_annotation',
      documentId,
      id: annotation.id,
      pageNumber: annotation.pageNumber,
      type: annotation.type,
      fabricData: annotation.data,
      timestamp,
      sequence: nextSequence(),
    });
  }
  for (const measurement of Object.values(backup.measurements).flat()) {
    operations.push({
      opType: 'create_measurement',
      documentId,
      id: measurement.id,
      pageNumber: measurement.pageNumber,
      type: measurement.type,
      label: measurement.label,
      valueLabel: measurement.valueLabel,
      realWorldValue: measurement.realWorldValue,
      unit: measurement.unit,
      points: measurement.points,
      fabricData: measurement.data,
      timestamp,
      sequence: nextSequence(),
    });
  }

  const scalePages = new Set([
    ...Object.keys(current.scales).map(Number),
    ...Object.keys(backup.scales).map(Number),
  ]);
  for (const pageNumber of scalePages) {
    const scale = backup.scales[pageNumber] ?? DEFAULT_SCALE;
    operations.push({
      opType: 'set_scale',
      documentId,
      id: `scale:${pageNumber}`,
      pageNumber,
      isSet: scale.set,
      pixelsPerUnit: scale.pixelsPerUnit,
      unit: scale.unit,
      realWorldUnit: scale.realWorldUnit,
      scaleKind: scale.scaleKind,
      presetRatio: scale.presetRatio,
      calibrationDistanceFeet: scale.calibrationDistanceFeet,
      timestamp,
      sequence: nextSequence(),
    });
  }

  return operations;
}