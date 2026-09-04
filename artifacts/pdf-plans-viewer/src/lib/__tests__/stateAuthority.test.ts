import { describe, expect, it } from 'vitest';

import { createStateAuthority } from '../stateAuthority';

describe('state authority', () => {
  it('prevents initial server hydration from replacing a newer backup import', async () => {
    const authority = createStateAuthority();
    const initialLoadToken = authority.claim();
    let releaseHydration!: () => void;
    const hydrationReady = new Promise<void>(resolve => {
      releaseHydration = resolve;
    });
    const applied: string[] = [];

    const initialHydration = (async () => {
      await hydrationReady;
      if (authority.isCurrent(initialLoadToken)) applied.push('server');
    })();

    authority.claim();
    applied.push('backup');
    releaseHydration();
    await initialHydration;

    expect(applied).toEqual(['backup']);
  });

  it('allows hydration when no newer state source has claimed authority', () => {
    const authority = createStateAuthority();
    const token = authority.claim();
    expect(authority.isCurrent(token)).toBe(true);
  });

  it('prevents an import started for one PDF from applying after another PDF opens', async () => {
    const authority = createStateAuthority();
    const importToken = authority.claim();
    let activeDocumentHash = 'pdf-a';

    const importCanApply = () => (
      authority.isCurrent(importToken) && activeDocumentHash === 'pdf-a'
    );

    activeDocumentHash = 'pdf-b';
    authority.claim();

    expect(importCanApply()).toBe(false);
  });

  it('prevents an older share response from replacing a newer backup import', () => {
    const authority = createStateAuthority();
    const shareToken = authority.claim();
    const importToken = authority.claim();

    expect(authority.isCurrent(shareToken)).toBe(false);
    expect(authority.isCurrent(importToken)).toBe(true);
  });
});