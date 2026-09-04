export interface PixelMeasurement {
  id: string;
  type: 'distance' | 'area';
  label?: string;
  valueLabel?: string;
  realWorldValue?: number;
  isPending: boolean;
}

export interface RecalculatedMeasurementValues {
  label: string;
  valueLabel: string;
  realWorldValue: number;
  unit: string;
}

interface RecalculationHandlers {
  updateConfirmed: (
    measurement: PixelMeasurement,
    values: RecalculatedMeasurementValues,
  ) => Promise<unknown>;
  updatePending: (
    measurement: PixelMeasurement,
    values: RecalculatedMeasurementValues,
  ) => Promise<unknown>;
  onProgress?: (completed: number, total: number) => void;
}

export function recalculatedMeasurementValues(
  measurement: Pick<PixelMeasurement, 'type' | 'label' | 'valueLabel' | 'realWorldValue'>,
  pixelsPerUnit: number,
  realWorldUnit: string,
): RecalculatedMeasurementValues {
  const isArea = measurement.type === 'area';
  const scaleFactor = isArea ? pixelsPerUnit * pixelsPerUnit : pixelsPerUnit;
  const realWorldValue = (measurement.realWorldValue ?? 0) / scaleFactor;
  const unit = isArea ? `${realWorldUnit}²` : realWorldUnit;
  const valueLabel = `${realWorldValue < 10 ? realWorldValue.toFixed(2) : realWorldValue.toFixed(1)} ${unit}`;

  return {
    realWorldValue,
    unit,
    label: measurement.label && measurement.label !== measurement.valueLabel
      ? measurement.label
      : valueLabel,
    valueLabel,
  };
}

/**
 * Recalculate all supplied pixel measurements. Every item is attempted so a
 * transient failure on one saved measurement never prevents the rest from
 * receiving the newly calibrated values.
 */
export async function recalculatePixelMeasurements(
  measurements: PixelMeasurement[],
  pixelsPerUnit: number,
  realWorldUnit: string,
  handlers: RecalculationHandlers,
): Promise<PixelMeasurement[]> {
  const failed: PixelMeasurement[] = [];
  let completed = 0;
  handlers.onProgress?.(completed, measurements.length);

  for (const measurement of measurements) {
    const values = recalculatedMeasurementValues(
      measurement,
      pixelsPerUnit,
      realWorldUnit,
    );

    try {
      if (measurement.isPending) {
        await handlers.updatePending(measurement, values);
      } else {
        await handlers.updateConfirmed(measurement, values);
      }
    } catch {
      failed.push(measurement);
    } finally {
      completed += 1;
      handlers.onProgress?.(completed, measurements.length);
    }
  }

  return failed;
}