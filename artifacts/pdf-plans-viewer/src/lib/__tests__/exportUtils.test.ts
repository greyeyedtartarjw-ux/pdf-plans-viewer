import { describe, expect, it } from 'vitest';

import { BackupValidationError, parseBackupJSON } from '../exportUtils';

const validBackup = {
  exportedAt: '2026-09-04T12:00:00.000Z',
  document: 'floor-plan.pdf',
  scales: {
    1: {
      set: true,
      pixelsPerUnit: 18,
      unit: 'px',
      realWorldUnit: 'ft',
      scaleKind: 'preset',
      presetRatio: '1/4',
      calibrationDistanceFeet: null,
    },
  },
  annotations: {
    1: [{ id: 'annotation-1', pageNumber: 1, type: 'note', data: { type: 'textbox', text: 'Check wall' } }],
  },
  measurements: {
    1: [{
      id: 'measurement-1',
      pageNumber: 1,
      type: 'distance',
      label: '12 ft',
      realWorldValue: 12,
      unit: 'ft',
      points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      data: { type: 'group' },
    }],
  },
};

describe('parseBackupJSON', () => {
  it('accepts a backup exported for the open document', () => {
    expect(parseBackupJSON(JSON.stringify(validBackup), 'floor-plan.pdf', 2)).toEqual(validBackup);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseBackupJSON('{', 'floor-plan.pdf', 2))
      .toThrow(new BackupValidationError('This file is not valid JSON.'));
  });

  it('rejects a backup for another document', () => {
    expect(() => parseBackupJSON(JSON.stringify(validBackup), 'another.pdf', 2))
      .toThrow('This backup is for "floor-plan.pdf", not "another.pdf".');
  });

  it('rejects items whose page is outside the open PDF', () => {
    const backup = { ...validBackup, annotations: { 3: [] } };
    expect(() => parseBackupJSON(JSON.stringify(backup), 'floor-plan.pdf', 2))
      .toThrow('The backup contains annotations for invalid page 3.');
  });

  it('rejects malformed measurements without changing any state', () => {
    const backup = {
      ...validBackup,
      measurements: { 1: [{ ...validBackup.measurements[1][0], points: [{ x: 'bad', y: 2 }] }] },
    };
    expect(() => parseBackupJSON(JSON.stringify(backup), 'floor-plan.pdf', 2))
      .toThrow('Measurement 1 on page 1 is invalid.');
  });

  it('rejects annotation data that Fabric cannot decode as an object', () => {
    const backup = {
      ...validBackup,
      annotations: { 1: [{ ...validBackup.annotations[1][0], data: null }] },
    };
    expect(() => parseBackupJSON(JSON.stringify(backup), 'floor-plan.pdf', 2))
      .toThrow('Annotation 1 on page 1 is invalid.');
  });

  it('rejects measurement data without a serialized Fabric type', () => {
    const backup = {
      ...validBackup,
      measurements: { 1: [{ ...validBackup.measurements[1][0], data: {} }] },
    };
    expect(() => parseBackupJSON(JSON.stringify(backup), 'floor-plan.pdf', 2))
      .toThrow('Measurement 1 on page 1 is invalid.');
  });
});