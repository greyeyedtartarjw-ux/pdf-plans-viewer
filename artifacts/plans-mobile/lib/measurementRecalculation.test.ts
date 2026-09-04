import { describe, expect, it, vi } from 'vitest';
import {
  recalculatePixelMeasurements,
  type PixelMeasurement,
} from './measurementRecalculation';

const distance: PixelMeasurement = {
  id: 'distance',
  type: 'distance',
  realWorldValue: 30,
  isPending: false,
};

const area: PixelMeasurement = {
  id: 'area',
  type: 'area',
  realWorldValue: 900,
  isPending: false,
};

const pending: PixelMeasurement = {
  id: 'pending',
  type: 'distance',
  realWorldValue: 50,
  isPending: true,
};

describe('pixel measurement recalculation', () => {
  it('preserves a custom label while replacing only the generated value label', async () => {
    const custom: PixelMeasurement = {
      id: 'custom',
      type: 'distance',
      label: 'North wall',
      valueLabel: '30.0 px',
      realWorldValue: 30,
      isPending: false,
    };

    const updateConfirmed = vi.fn(async () => undefined);
    await recalculatePixelMeasurements([custom], 10, 'm', {
      updateConfirmed,
      updatePending: vi.fn(async () => undefined),
    });

    expect(updateConfirmed).toHaveBeenCalledWith(custom, {
      label: 'North wall',
      valueLabel: '3.00 m',
      realWorldValue: 3,
      unit: 'm',
    });
  });

  it('converts distance, area, and pending queue payloads using the new scale', async () => {
    const updateConfirmed = vi.fn(async () => undefined);
    const updatePending = vi.fn(async () => undefined);
    const progress: Array<[number, number]> = [];

    const failed = await recalculatePixelMeasurements(
      [distance, area, pending],
      10,
      'm',
      {
        updateConfirmed,
        updatePending,
        onProgress: (completed, total) => progress.push([completed, total]),
      },
    );

    expect(failed).toEqual([]);
    expect(updateConfirmed).toHaveBeenNthCalledWith(1, distance, {
      realWorldValue: 3,
      unit: 'm',
      label: '3.00 m',
      valueLabel: '3.00 m',
    });
    expect(updateConfirmed).toHaveBeenNthCalledWith(2, area, {
      realWorldValue: 9,
      unit: 'm²',
      label: '9.00 m²',
      valueLabel: '9.00 m²',
    });
    expect(updatePending).toHaveBeenCalledWith(pending, {
      realWorldValue: 5,
      unit: 'm',
      label: '5.00 m',
      valueLabel: '5.00 m',
    });
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('continues after a failed server update and returns only the retryable item', async () => {
    const failedUpdate = vi.fn(async (
      _measurement: PixelMeasurement,
      _values: { label: string; valueLabel: string; realWorldValue: number; unit: string },
    ) => {
      throw new Error('offline');
    });
    const successfulUpdate = vi.fn(async (
      _measurement: PixelMeasurement,
      _values: { label: string; valueLabel: string; realWorldValue: number; unit: string },
    ) => undefined);

    const failed = await recalculatePixelMeasurements(
      [distance, area],
      10,
      'm',
      {
        updateConfirmed: async (measurement, values) => {
          if (measurement.id === distance.id) {
            await failedUpdate(measurement, values);
          } else {
            await successfulUpdate(measurement, values);
          }
        },
        updatePending: vi.fn(async () => undefined),
      },
    );

    expect(failed).toEqual([distance]);
    expect(successfulUpdate).toHaveBeenCalledWith(area, {
      realWorldValue: 9,
      unit: 'm²',
      label: '9.00 m²',
      valueLabel: '9.00 m²',
    });
  });
});