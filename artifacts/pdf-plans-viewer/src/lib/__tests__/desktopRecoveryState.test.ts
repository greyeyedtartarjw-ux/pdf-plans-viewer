import { describe, expect, it } from 'vitest';
import {
  desktopRecoveryReducer,
  initialDesktopRecoveryState,
} from '../desktopRecoveryState';

describe('desktop recovery import transaction', () => {
  it('keeps the previous complete PDF/state pair when a replacement is interrupted', () => {
    const previous = desktopRecoveryReducer(initialDesktopRecoveryState, {
      type: 'commit',
      recoveryId: 'previous.pdf',
    });
    const interrupted = desktopRecoveryReducer(previous, {
      type: 'stage',
      recoveryId: 'slow-replacement.pdf',
    });

    expect(interrupted.committedRecoveryId).toBe('previous.pdf');
    expect(interrupted.stagedRecoveryId).toBe('slow-replacement.pdf');
  });

  it('publishes the replacement only when its matching viewer state commits', () => {
    const staged = desktopRecoveryReducer(initialDesktopRecoveryState, {
      type: 'stage',
      recoveryId: 'replacement.pdf',
    });
    const committed = desktopRecoveryReducer(staged, {
      type: 'commit',
      recoveryId: 'replacement.pdf',
    });

    expect(committed).toEqual({
      committedRecoveryId: 'replacement.pdf',
      stagedRecoveryId: null,
    });
  });
});