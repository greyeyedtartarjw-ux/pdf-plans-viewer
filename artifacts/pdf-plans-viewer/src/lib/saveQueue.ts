/**
 * saveQueue.ts
 *
 * Framework-agnostic save queue extracted from PDFPageViewer so the
 * connectivity-failure retry logic can be unit tested without React.
 *
 * Key behaviour:
 *  - When `serverUnreachable` is true, skip the API call, fire an "unable to
 *    save" toast, and enqueue the operation for later retry.
 *  - When the server drops *between* the health-check and the actual API call
 *    (the race condition), we catch the network failure on the second attempt
 *    and enqueue it the same way.
 *  - `retryAll` drains the queue, fires a success toast on full success, or a
 *    destructive toast listing the remaining failure count on partial failure
 *    and throws so the caller can surface the error.
 */

export interface QueueEntry {
  fn: () => Promise<unknown>;
  errorTitle: string;
}

export interface ToastOptions {
  variant?: 'destructive' | 'default';
  title: string;
  description?: string;
}

export type ToastFn = (opts: ToastOptions) => void;

/**
 * Optional notifications for callers that need to reflect queue activity in
 * surrounding UI (for example, a "Saving…" status indicator). The queue
 * remains framework-agnostic; consumers decide how to present these events.
 */
export interface SaveQueueEvents {
  onSaveStart?: () => void;
  onSaveComplete?: (
    outcome: 'saved' | 'queued' | 'terminalFailure',
    attemptedRequest: boolean,
  ) => void;
  onRetryStart?: (attemptedCount: number) => void;
  onRetryComplete?: (attemptedCount: number, failureCount: number) => void;
}

/**
 * Returns true when an HTTP error status should never be retried.
 * 4xx errors (except 429 Too Many Requests) are client errors that a retry
 * cannot fix. 409 Conflict in particular signals the record already exists.
 */
export function isNonRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

export interface SaveQueue {
  /**
   * Attempt fn(), retrying once on transient failure.
   * When serverUnreachable or both attempts fail, enqueue for later retry.
   */
  saveWithRetry(
    fn: () => Promise<unknown>,
    errorTitle: string,
    serverUnreachable: boolean,
  ): Promise<void>;

  /** Number of operations currently waiting for retry. */
  pendingCount(): number;

  /**
   * Drain the retry queue.
   * Resolves on full success, throws on any remaining failure.
   */
  retryAll(): Promise<void>;
}

export function createSaveQueue(toast: ToastFn, events: SaveQueueEvents = {}): SaveQueue {
  // Internal mutable queue — intentionally not exposed directly so callers
  // can only interact through the controlled API.
  const queue: QueueEntry[] = [];

  async function saveWithRetry(
    fn: () => Promise<unknown>,
    errorTitle: string,
    serverUnreachable: boolean,
  ): Promise<void> {
    if (serverUnreachable) {
      toast({
        variant: 'destructive',
        title: 'Unable to save — server is unreachable',
        description:
          'Your work is visible on screen. It will be queued for retry when the connection is restored.',
      });
      queue.push({ fn, errorTitle });
      events.onSaveComplete?.('queued', false);
      return;
    }

    events.onSaveStart?.();
    try {
      await fn();
      events.onSaveComplete?.('saved', true);
      return; // success path
    } catch (firstErr) {
      if (isNonRetryable(firstErr)) {
        // Client error — retrying won't help; surface immediately and stop.
        toast({
          variant: 'destructive',
          title: errorTitle,
          description:
            firstErr instanceof Error
              ? firstErr.message
              : 'Please check your connection and try again.',
        });
        events.onSaveComplete?.('terminalFailure', true);
        return;
      }

      // Transient failure — try once more (server may have blipped).
      try {
        await fn();
        events.onSaveComplete?.('saved', true);
      } catch {
        // Second attempt also failed: server dropped between health-check and
        // this call. Queue for retry and notify the user.
        queue.push({ fn, errorTitle });
        toast({
          variant: 'destructive',
          title: 'Unable to save — server is unreachable',
          description: 'Your work is visible on screen and has been queued for retry.',
        });
        events.onSaveComplete?.('queued', true);
      }
    }
  }

  async function retryAll(): Promise<void> {
    const toRetry = [...queue];
    // Clear the queue before awaiting so concurrent calls don't double-enqueue.
    queue.length = 0;
    events.onRetryStart?.(toRetry.length);

    const results = await Promise.allSettled(toRetry.map(({ fn }) => fn()));

    // Re-enqueue only retryable failures. Client errors such as 409 Conflict
    // are terminal and must be surfaced without creating a permanently stuck
    // retry entry.
    results.forEach((result, i) => {
      if (result.status === 'rejected' && !isNonRetryable(result.reason)) {
        queue.push(toRetry[i]);
      }
    });

    const failureCount = results.filter(r => r.status === 'rejected').length;
    const retryableFailureCount = queue.length;
    events.onRetryComplete?.(toRetry.length, failureCount);
    if (failureCount > 0) {
      toast({
        variant: 'destructive',
        title: 'Some changes could not be saved',
        description:
          retryableFailureCount > 0
            ? `${retryableFailureCount} item(s) still failed. Check your connection.`
            : `${failureCount} item(s) were rejected by the server and will not be retried.`,
      });
      throw new Error('Partial retry failure');
    }

    toast({
      title: 'Changes saved',
      description: 'All previously unsaved changes have been saved successfully.',
    });
  }

  return {
    saveWithRetry,
    pendingCount: () => queue.length,
    retryAll,
  };
}
