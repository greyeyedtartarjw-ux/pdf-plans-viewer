/**
 * useOfflineQueue
 *
 * React hook that wires the serialized offline queue (lib/offlineQueue.ts)
 * to component state and NetInfo for automatic sync on network restore.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { createMeasurement } from '@workspace/api-client-react';
import { upsertCachedMeasurement } from '@/lib/measurementsCache';
import {
  enqueue as qEnqueue,
  dequeue as qDequeue,
  flush as qFlush,
  loadQueue,
} from '@/lib/offlineQueue';

export type { PendingMeasurement } from '@/lib/offlineQueue';
export { PENDING_MEASUREMENTS_KEY } from '@/lib/offlineQueue';

export function useOfflineQueue() {
  const [pendingQueue, setPendingQueue] = useState<
    import('@/lib/offlineQueue').PendingMeasurement[]
  >([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncingRef = useRef(false);

  // Load persisted queue on mount
  useEffect(() => {
    loadQueue().then(setPendingQueue);
  }, []);

  // ── flush all pending items to the API ───────────────────────────────────
  const flush = useCallback(
    async (
      queue: import('@/lib/offlineQueue').PendingMeasurement[],
    ) => {
      if (syncingRef.current || queue.length === 0) return;
      syncingRef.current = true;
      setIsSyncing(true);

      try {
        const remaining = await qFlush(async (docId, input) => {
          const created = await createMeasurement(docId, input);
          // A queued save can be the first measurement confirmed during this
          // session, so write it to the offline cache before removing it from
          // the retry queue.
          await upsertCachedMeasurement(docId, created);
          return created;
        });
        setPendingQueue(remaining);
      } finally {
        syncingRef.current = false;
        setIsSyncing(false);
      }
    },
    [],
  );

  // Subscribe to network — flush when online
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        loadQueue().then((q) => flush(q));
      }
    });
    return unsub;
  }, [flush]);

  // ── enqueue ──────────────────────────────────────────────────────────────
  const enqueue = useCallback(
    async (item: import('@/lib/offlineQueue').PendingMeasurement) => {
      const next = await qEnqueue(item);
      setPendingQueue(next);
    },
    [],
  );

  // ── dequeue ──────────────────────────────────────────────────────────────
  const dequeue = useCallback(async (localId: string) => {
    const next = await qDequeue(localId);
    setPendingQueue(next);
  }, []);

  // ── pendingForDoc ────────────────────────────────────────────────────────
  const pendingForDoc = useCallback(
    (docId: number) => pendingQueue.filter((p) => p.docId === docId),
    [pendingQueue],
  );

  return { pendingQueue, pendingForDoc, isSyncing, enqueue, dequeue, flush };
}
