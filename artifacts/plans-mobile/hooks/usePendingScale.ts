import { useCallback, useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { setDocumentScale } from '@workspace/api-client-react';
import {
  enqueuePendingScale,
  flushPendingScale,
  loadPendingScale,
  type DocumentScaleInput,
  type PendingScale,
} from '@/lib/pendingScale';

/**
 * Restores the newest locally queued scale immediately and retries it when the
 * screen opens or network connectivity returns.
 */
export function usePendingScale(
  docId: number,
  onSynced: (input: DocumentScaleInput) => void,
) {
  const [pendingScale, setPendingScale] = useState<PendingScale | null>(null);

  const flush = useCallback(async () => {
    if (!docId) return null;
    const result = await flushPendingScale(docId, (input) => setDocumentScale(docId, input));
    setPendingScale(result.pending);
    if (result.synced) onSynced(result.synced.input);
    return result.pending;
  }, [docId, onSynced]);

  useEffect(() => {
    let isMounted = true;
    void loadPendingScale(docId).then((item) => {
      if (!isMounted) return;
      setPendingScale(item);
      if (item) void flush();
    });
    return () => {
      isMounted = false;
    };
  }, [docId, flush]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void flush();
      }
    });
    return unsubscribe;
  }, [flush]);

  const savePendingScale = useCallback(async (input: DocumentScaleInput) => {
    const item = await enqueuePendingScale(docId, input);
    setPendingScale(item);
    // The calibration is durable now. Do not await the API here: a slow older
    // request must never delay a newer user choice from being persisted or
    // reflected in the viewer.
    void flush();
    return item;
  }, [docId, flush]);

  return { pendingScale, savePendingScale };
}