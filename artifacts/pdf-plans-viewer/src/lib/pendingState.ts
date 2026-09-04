import type { Annotation, Measurement, Scale } from '../types';
import type { PendingOp } from './pendingQueue';

/**
 * Apply locally queued operations on top of a remote snapshot. Empty remote
 * maps are supported so this can restore pending work during an offline reopen.
 */
export function mergePendingState(
  remoteAnnotations: Record<number, Annotation[]>,
  remoteMeasurements: Record<number, Measurement[]>,
  pendingOps: PendingOp[],
  remoteScales: Record<number, Scale> = {},
) {
  const annotations = Object.fromEntries(
    Object.entries(remoteAnnotations).map(([page, items]) => [page, [...items]]),
  ) as Record<number, Annotation[]>;
  const measurements = Object.fromEntries(
    Object.entries(remoteMeasurements).map(([page, items]) => [page, [...items]]),
  ) as Record<number, Measurement[]>;
  const scales = { ...remoteScales };

  for (const op of pendingOps) {
    if (op.opType === 'create_annotation') {
      if (!annotations[op.pageNumber]) annotations[op.pageNumber] = [];
      if (!annotations[op.pageNumber].some((annotation) => annotation.id === op.id)) {
        annotations[op.pageNumber].push({
          id: op.id,
          pageNumber: op.pageNumber,
          type: op.type as Annotation['type'],
          data: op.fabricData,
        });
      }
    } else if (op.opType === 'update_annotation') {
      for (const page of Object.keys(annotations)) {
        annotations[+page] = annotations[+page].map((annotation) =>
          annotation.id === op.id
            ? { ...annotation, data: op.fabricData }
            : annotation,
        );
      }
    } else if (op.opType === 'delete_annotation') {
      for (const page of Object.keys(annotations)) {
        annotations[+page] = annotations[+page].filter((annotation) => annotation.id !== op.id);
      }
    } else if (op.opType === 'create_measurement') {
      if (!measurements[op.pageNumber]) measurements[op.pageNumber] = [];
      if (!measurements[op.pageNumber].some((measurement) => measurement.id === op.id)) {
        measurements[op.pageNumber].push({
          id: op.id,
          pageNumber: op.pageNumber,
          type: op.type as Measurement['type'],
          label: op.label,
          realWorldValue: op.realWorldValue,
          unit: op.unit,
          points: op.points,
          data: op.fabricData,
        });
      }
    } else if (op.opType === 'delete_measurement') {
      for (const page of Object.keys(measurements)) {
        measurements[+page] = measurements[+page].filter((measurement) => measurement.id !== op.id);
      }
    } else if (op.opType === 'update_measurement') {
      for (const page of Object.keys(measurements)) {
        measurements[+page] = measurements[+page].map((measurement) =>
          measurement.id === op.id
            ? {
                ...measurement,
                label: op.label,
                realWorldValue: op.realWorldValue,
                unit: op.unit,
                data: op.fabricData,
              }
            : measurement,
        );
      }
    } else if (op.opType === 'set_scale') {
      scales[op.pageNumber] = {
        set: op.isSet,
        pixelsPerUnit: op.pixelsPerUnit,
        unit: 'px',
        realWorldUnit: 'ft',
        scaleKind: op.scaleKind,
        presetRatio: op.presetRatio,
        calibrationDistanceFeet: op.calibrationDistanceFeet,
      };
    }
  }

  return { annotations, measurements, scales };
}