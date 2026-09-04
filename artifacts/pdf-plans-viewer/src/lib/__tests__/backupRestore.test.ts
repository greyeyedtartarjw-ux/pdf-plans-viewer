import { describe, expect, it } from 'vitest';

import type { BackupData } from '../exportUtils';
import { createBackupRestoreOps } from '../backupRestore';
import { mergePendingState } from '../pendingState';

const oldAnnotation = {
  id: 'same-id',
  pageNumber: 1,
  type: 'note' as const,
  data: { type: 'textbox', text: 'old' },
};
const restoredAnnotation = {
  ...oldAnnotation,
  data: { type: 'textbox', text: 'restored' },
};
const restoredMeasurement = {
  id: 'restored-measurement',
  pageNumber: 1,
  type: 'distance' as const,
  label: '8 ft',
  valueLabel: '8 ft',
  realWorldValue: 8,
  unit: 'ft',
  points: [{ x: 0, y: 0 }, { x: 8, y: 0 }],
  data: { type: 'group' },
};
const restoredScale = {
  set: true,
  pixelsPerUnit: 18,
  unit: 'px' as const,
  realWorldUnit: 'ft' as const,
  scaleKind: 'preset' as const,
  presetRatio: '1/4' as const,
  calibrationDistanceFeet: null,
};

function backup(): BackupData {
  return {
    exportedAt: '2026-09-04T12:00:00.000Z',
    document: 'plan.pdf',
    annotations: { 1: [restoredAnnotation] },
    measurements: { 1: [restoredMeasurement] },
    scales: { 1: restoredScale },
  };
}

describe('backup restore operations', () => {
  it('deletes the current snapshot before recreating the imported snapshot', () => {
    let sequence = 0;
    const ops = createBackupRestoreOps(
      7,
      { annotations: { 1: [oldAnnotation] }, measurements: {}, scales: {} },
      backup(),
      () => ++sequence,
    );

    expect(ops.map(op => op.opType)).toEqual([
      'delete_annotation',
      'create_annotation',
      'create_measurement',
      'set_scale',
    ]);
  });

  it('reconstructs the imported snapshot over stale server state after reload', () => {
    let sequence = 0;
    const imported = backup();
    const ops = createBackupRestoreOps(
      7,
      { annotations: { 1: [oldAnnotation] }, measurements: {}, scales: {} },
      imported,
      () => ++sequence,
    );
    const merged = mergePendingState(
      { 1: [oldAnnotation] },
      {},
      ops,
      {},
    );

    expect(merged.annotations).toEqual(imported.annotations);
    expect(merged.measurements).toEqual(imported.measurements);
    expect(merged.scales).toEqual(imported.scales);
  });

  it('queues a scale reset when the imported backup has no current page scale', () => {
    let sequence = 0;
    const imported = { ...backup(), scales: {} };
    const ops = createBackupRestoreOps(
      7,
      { annotations: {}, measurements: {}, scales: { 1: restoredScale } },
      imported,
      () => ++sequence,
    );
    const scaleOp = ops.find(op => op.opType === 'set_scale');

    expect(scaleOp).toMatchObject({ opType: 'set_scale', pageNumber: 1, isSet: false });
  });
});