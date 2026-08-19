import { describe, expect, it } from 'vitest';
import { createViewerHtml } from '../constants/viewerHtml';

describe('createViewerHtml', () => {
  it('loads PDF.js and its worker from the bundled asset URLs', () => {
    const libraryUri = 'file:///app/assets/pdf.min.txt';
    const workerUri = 'file:///app/assets/pdf.worker.min.txt';

    const html = createViewerHtml(libraryUri, workerUri);

    expect(html).toContain(`<script src="${libraryUri}"></script>`);
    expect(html).toContain(`workerSrc=${JSON.stringify(workerUri)}`);
    expect(html).not.toContain('cdnjs.cloudflare.com');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});