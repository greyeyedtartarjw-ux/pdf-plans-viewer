/**
 * saveQueue.test.ts
 *
 * Tests for the connectivity-failure retry queue extracted from PDFPageViewer.
 *
 * Covered scenarios:
 *  1. isNonRetryable — HTTP status classification
 *  2. saveWithRetry when serverUnreachable is true
 *  3. saveWithRetry race-condition: server drops between health-check and save
 *  4. saveWithRetry with a non-retryable 4xx — NOT enqueued
 *  5. retryAll — drains queue, success toast on full success
 *  6. retryAll — partial failure re-enqueues only the failed items
 *  7. window callback integration (_pendingRetryCount / _retryFailedSaves)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSaveQueue, isNonRetryable } from '../saveQueue';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeToast() {
  const calls: Array<{ variant?: string; title: string; description?: string }> = [];
  const fn = vi.fn((opts: { variant?: string; title: string; description?: string }) => {
    calls.push(opts);
  });
  return { fn, calls };
}

/** Builds an Error-like object with a `.status` field (mimics api-client errors). */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// ─── isNonRetryable ───────────────────────────────────────────────────────────

describe('isNonRetryable', () => {
  it('returns true for 400 Bad Request', () => {
    expect(isNonRetryable(httpError(400))).toBe(true);
  });

  it('returns true for 404 Not Found', () => {
    expect(isNonRetryable(httpError(404))).toBe(true);
  });

  it('returns true for 409 Conflict', () => {
    expect(isNonRetryable(httpError(409))).toBe(true);
  });

  it('returns false for 429 Too Many Requests (should be retried)', () => {
    expect(isNonRetryable(httpError(429))).toBe(false);
  });

  it('returns false for 500 Internal Server Error', () => {
    expect(isNonRetryable(httpError(500))).toBe(false);
  });

  it('returns false for a plain Error with no status', () => {
    expect(isNonRetryable(new Error('network failure'))).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isNonRetryable(null)).toBe(false);
    expect(isNonRetryable(undefined)).toBe(false);
  });
});

// ─── saveWithRetry — serverUnreachable path ───────────────────────────────────

describe('saveWithRetry — serverUnreachable = true', () => {
  it('fires the "Unable to save" toast with the correct title', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);

    await q.saveWithRetry(() => Promise.resolve(), 'Test save', true);

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Unable to save — server is unreachable');
    expect(calls[0].variant).toBe('destructive');
  });

  it('enqueues the operation so pendingCount increases', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    expect(q.pendingCount()).toBe(0);
    await q.saveWithRetry(() => Promise.resolve(), 'Save A', true);
    expect(q.pendingCount()).toBe(1);
    await q.saveWithRetry(() => Promise.resolve(), 'Save B', true);
    expect(q.pendingCount()).toBe(2);
  });

  it('does NOT call the api fn when the server is unreachable', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);
    const fn = vi.fn(() => Promise.resolve());

    await q.saveWithRetry(fn, 'Save', true);

    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── saveWithRetry — race-condition (server drops between health-check & call)──

describe('saveWithRetry — race condition: both attempts fail', () => {
  it('fires the "Unable to save" toast after both retries fail', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);

    // Simulate network failure on every call
    const fn = vi.fn(() => Promise.reject(new Error('Network failure')));

    await q.saveWithRetry(fn, 'Measurement not saved', false);

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Unable to save — server is unreachable');
    expect(calls[0].variant).toBe('destructive');
  });

  it('enqueues the item when both retry attempts fail', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    const fn = vi.fn(() => Promise.reject(new Error('Network failure')));

    expect(q.pendingCount()).toBe(0);
    await q.saveWithRetry(fn, 'Measurement not saved', false);
    expect(q.pendingCount()).toBe(1);
  });

  it('calls the api fn exactly twice (initial + one retry)', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    const fn = vi.fn(() => Promise.reject(new Error('Network failure')));
    await q.saveWithRetry(fn, 'Save', false);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT enqueue when the first attempt succeeds', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    const fn = vi.fn(() => Promise.resolve());
    await q.saveWithRetry(fn, 'Save', false);

    expect(q.pendingCount()).toBe(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the second attempt succeeds (transient blip)', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    let callCount = 0;
    const fn = vi.fn(() => {
      callCount++;
      return callCount === 1
        ? Promise.reject(new Error('Transient error'))
        : Promise.resolve();
    });

    await q.saveWithRetry(fn, 'Save', false);

    expect(q.pendingCount()).toBe(0);
    expect(toast).not.toHaveBeenCalled();
  });
});

// ─── saveWithRetry — non-retryable 4xx ───────────────────────────────────────

describe('saveWithRetry — non-retryable client error', () => {
  it('shows a descriptive toast but does NOT enqueue the item', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);

    const fn = vi.fn(() => Promise.reject(httpError(409)));
    await q.saveWithRetry(fn, 'Annotation not saved', false);

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Annotation not saved');
    expect(q.pendingCount()).toBe(0);
  });

  it('calls the api fn exactly once for a 4xx (no retry)', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    const fn = vi.fn(() => Promise.reject(httpError(404)));
    await q.saveWithRetry(fn, 'Not found', false);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once for 429 Too Many Requests', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    const fn = vi.fn(() => Promise.reject(httpError(429)));
    await q.saveWithRetry(fn, 'Rate limited', false);

    // 429 is retryable — expect 2 attempts and item queued
    expect(fn).toHaveBeenCalledTimes(2);
    expect(q.pendingCount()).toBe(1);
  });
});

// ─── retryAll ─────────────────────────────────────────────────────────────────

describe('retryAll — full success', () => {
  it('drains the queue to zero', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    // Enqueue two items by simulating serverUnreachable saves
    await q.saveWithRetry(() => Promise.resolve(), 'A', true);
    await q.saveWithRetry(() => Promise.resolve(), 'B', true);
    expect(q.pendingCount()).toBe(2);

    // Now retry succeeds
    await q.retryAll();
    expect(q.pendingCount()).toBe(0);
  });

  it('shows the success toast with the correct title', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);

    // Queue one item (the enqueue toast is calls[0])
    await q.saveWithRetry(() => Promise.resolve(), 'A', true);
    calls.length = 0; // clear earlier toasts

    await q.retryAll();

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Changes saved');
    expect(calls[0].variant).toBeUndefined(); // not destructive
  });

  it('does not throw when the queue is empty', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    await expect(q.retryAll()).resolves.toBeUndefined();
  });
});

describe('retryAll — partial failure', () => {
  it('re-enqueues only the items that still fail', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    // Enqueue three items
    let aAttempts = 0;
    const fnA = vi.fn(() => { aAttempts++; return Promise.resolve(); }); // always succeeds
    const fnB = vi.fn(() => Promise.reject(new Error('still broken')));  // always fails
    const fnC = vi.fn(() => Promise.resolve());                          // always succeeds

    await q.saveWithRetry(fnA, 'A', true);
    await q.saveWithRetry(fnB, 'B', true);
    await q.saveWithRetry(fnC, 'C', true);
    expect(q.pendingCount()).toBe(3);

    await expect(q.retryAll()).rejects.toThrow('Partial retry failure');

    // Only the B item remains in the queue
    expect(q.pendingCount()).toBe(1);
  });

  it('fires the destructive toast describing remaining failure count', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);

    const failingFn = vi.fn(() => Promise.reject(new Error('broken')));
    await q.saveWithRetry(failingFn, 'A', true);
    await q.saveWithRetry(failingFn, 'B', true);
    calls.length = 0; // clear enqueue toasts

    await expect(q.retryAll()).rejects.toThrow();

    const retryToast = calls[0];
    expect(retryToast.variant).toBe('destructive');
    expect(retryToast.title).toBe('Some changes could not be saved');
    expect(retryToast.description).toMatch(/2 item\(s\)/);
  });

  it('throws so the caller knows the retry only partially succeeded', async () => {
    const { fn: toast } = makeToast();
    const q = createSaveQueue(toast);

    await q.saveWithRetry(() => Promise.reject(new Error('fail')), 'X', true);
    await expect(q.retryAll()).rejects.toThrow('Partial retry failure');
  });
});

// ─── window callback integration ─────────────────────────────────────────────

describe('window._pendingRetryCount and window._retryFailedSaves integration', () => {
  const win = globalThis as any;

  beforeEach(() => {
    delete win._pendingRetryCount;
    delete win._retryFailedSaves;
  });

  /**
   * Simulates what PDFPageViewer does in its useEffect on mount:
   * register the window callbacks pointing at the queue instance.
   */
  function mountCallbacks(queue: ReturnType<typeof createSaveQueue>) {
    win._pendingRetryCount = () => queue.pendingCount();
    win._retryFailedSaves = () => queue.retryAll();
    return () => {
      delete win._pendingRetryCount;
      delete win._retryFailedSaves;
    };
  }

  it('_pendingRetryCount returns 0 before any failed saves', () => {
    const q = createSaveQueue(makeToast().fn);
    mountCallbacks(q);
    expect(win._pendingRetryCount()).toBe(0);
  });

  it('_pendingRetryCount reflects queued items after a connectivity failure', async () => {
    const q = createSaveQueue(makeToast().fn);
    mountCallbacks(q);

    await q.saveWithRetry(() => Promise.resolve(), 'Save', true);
    await q.saveWithRetry(() => Promise.resolve(), 'Save', true);

    expect(win._pendingRetryCount()).toBe(2);
  });

  it('_retryFailedSaves drains the queue and _pendingRetryCount returns 0', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);
    mountCallbacks(q);

    // Simulate a save that was queued while the server was unreachable
    await q.saveWithRetry(() => Promise.resolve(), 'Measurement not saved', true);
    expect(win._pendingRetryCount()).toBe(1);

    calls.length = 0;
    await win._retryFailedSaves();

    expect(win._pendingRetryCount()).toBe(0);
    expect(calls[0].title).toBe('Changes saved');
  });

  it('_retryFailedSaves after a race-condition failure: clears queue on reconnect', async () => {
    const { fn: toast, calls } = makeToast();
    const q = createSaveQueue(toast);
    mountCallbacks(q);

    // First save attempt: server drops on both tries (race condition scenario)
    const fn = vi.fn(() => Promise.reject(new Error('Network failure')));
    await q.saveWithRetry(fn, 'Measurement not saved', false);

    // Verify the queue filled
    expect(win._pendingRetryCount()).toBeGreaterThan(0);

    // Server recovers — retry should now succeed
    fn.mockResolvedValue(undefined);
    calls.length = 0;

    await win._retryFailedSaves();

    expect(win._pendingRetryCount()).toBe(0);
    expect(calls.some((c: any) => c.title === 'Changes saved')).toBe(true);
  });

  it('unmounting cleans up window callbacks', () => {
    const q = createSaveQueue(makeToast().fn);
    const unmount = mountCallbacks(q);

    expect(typeof win._pendingRetryCount).toBe('function');
    unmount();
    expect(win._pendingRetryCount).toBeUndefined();
    expect(win._retryFailedSaves).toBeUndefined();
  });
});
