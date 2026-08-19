import { useCallback, useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { setDocumentPageScale } from '@workspace/api-client-react';
import {
  enqueuePendingScale,
  flushAllPendingScales,
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
  pageNumber: number,
  onSynced: (pageNumber: number, input: DocumentScaleInput) => void,
) {
  const [pendingScale, setPendingScale] = useState<PendingScale | null>(null);

  const flush = useCallback(async () => {
    if (!docId) return null;
    const result = await flushPendingScale(
      docId,
      pageNumber,
      (targetPage, input) => setDocumentPageScale(docId, targetPage, input),
    );
    setPendingScale(result.pending);
    if (result.synced) onSynced(result.synced.pageNumber, result.synced.input);
    return result.pending;
  }, [docId, pageNumber, onSynced]);

  const flushAll = useCallback(async () => {
    if (!docId) return;
    const results = await flushAllPendingScales(
      docId,
      (targetPage, input) => setDocumentPageScale(docId, targetPage, input),
    );
    const current = results.find((result) => result.pending?.pageNumber === pageNumber
      || result.synced?.pageNumber === pageNumber);
    if (current) setPendingScale(current.pending);
    for (const result of results) {
      if (result.synced) onSynced(result.synced.pageNumber, result.synced.input);
    }
  }, [docId, pageNumber, onSynced]);

  useEffect(() => {
    let isMounted = true;
    void loadPendingScale(docId, pageNumber).then((item) => {
      if (!isMounted) return;
      setPendingScale(item);
      if (item) void flush();
    });
    return () => {
      isMounted = false;
    };
  }, [docId, pageNumber, flush]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void flushAll();
      }
    });
    return unsubscribe;
  }, [flushAll]);

  const savePendingScale = useCallback(async (input: DocumentScaleInput) => {
    const item = await enqueuePendingScale(docId, pageNumber, input);
    setPendingScale(item);
    // The calibration is durable now. Do not await the API here: a slow older
    // request must never delay a newer user choice from being persisted or
    // reflected in the viewer.
    void flush();
    return item;
  }, [docId, flush]);

  return { pendingScale, savePendingScale };
}