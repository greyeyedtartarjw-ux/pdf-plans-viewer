export interface DesktopRecoveryState {
  committedRecoveryId: string | null;
  stagedRecoveryId: string | null;
}

export type DesktopRecoveryAction =
  | { type: 'stage'; recoveryId: string }
  | { type: 'commit'; recoveryId: string }
  | { type: 'abandon'; recoveryId: string };

export const initialDesktopRecoveryState: DesktopRecoveryState = {
  committedRecoveryId: null,
  stagedRecoveryId: null,
};

/**
 * Staging never changes the ID used by autosave. Only a commit performed with
 * the matching viewer-state update may publish a new recovery PDF.
 */
export function desktopRecoveryReducer(
  state: DesktopRecoveryState,
  action: DesktopRecoveryAction,
): DesktopRecoveryState {
  if (action.type === 'stage') {
    return { ...state, stagedRecoveryId: action.recoveryId };
  }
  if (action.type === 'commit') {
    return {
      committedRecoveryId: action.recoveryId,
      stagedRecoveryId: state.stagedRecoveryId === action.recoveryId
        ? null
        : state.stagedRecoveryId,
    };
  }
  return state.stagedRecoveryId === action.recoveryId
    ? { ...state, stagedRecoveryId: null }
    : state;
}