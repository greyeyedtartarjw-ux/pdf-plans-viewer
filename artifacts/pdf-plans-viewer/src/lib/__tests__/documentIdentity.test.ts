import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDocumentContentHash, getLegacyDocumentKey } from '../documentIdentity';
import {
  getCachedDocumentId,
  removeCachedDocumentId,
  setCachedDocumentId,
} from '../pendingQueue';

function makeFile(bytes: number[], name: string): File {
  return Object.assign(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), { name }) as File;
}

function createLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

describe('PDF content identity', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('crypto', webcrypto);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps same-name, same-size PDFs in separate pending-document queues', async () => {
    const first = makeFile([1, 2, 3, 4], 'plan.pdf');
    const second = makeFile([4, 3, 2, 1], 'plan.pdf');
    expect(first.size).toBe(second.size);
    expect(getLegacyDocumentKey(first)).toBe(getLegacyDocumentKey(second));

    const firstHash = await getDocumentContentHash(first);
    const secondHash = await getDocumentContentHash(second);
    expect(firstHash).not.toBe(secondHash);

    setCachedDocumentId(firstHash, 201);
    setCachedDocumentId(secondHash, 202);
    expect(getCachedDocumentId(firstHash)).toBe(201);
    expect(getCachedDocumentId(secondHash)).toBe(202);
  });

  it('restores a queue when identical content is reopened under a new filename', async () => {
    const original = makeFile([9, 8, 7, 6], 'first-name.pdf');
    const renamed = makeFile([9, 8, 7, 6], 'renamed-plan.pdf');

    const originalHash = await getDocumentContentHash(original);
    const renamedHash = await getDocumentContentHash(renamed);
    expect(originalHash).toBe(renamedHash);

    setCachedDocumentId(originalHash, 203);
    expect(getCachedDocumentId(renamedHash)).toBe(203);
  });

  it('does not trust legacy name-and-size mappings during the content-hash upgrade', async () => {
    const file = makeFile([1, 2, 3, 4], 'plan.pdf');
    const legacyKey = getLegacyDocumentKey(file);
    const contentHash = await getDocumentContentHash(file);

    setCachedDocumentId(legacyKey, 999);
    removeCachedDocumentId(legacyKey);
    setCachedDocumentId(contentHash, 204);

    expect(getCachedDocumentId(legacyKey)).toBeNull();
    expect(getCachedDocumentId(contentHash)).toBe(204);
  });
});