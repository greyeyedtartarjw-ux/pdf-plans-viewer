import { describe, expect, it } from 'vitest';
import {
  filenameFromUri,
  isSharedPdfUrl,
  sharedPdfUri,
} from './usePdfImport';

describe('shared PDF URLs', () => {
  it('accepts local, content, and HTTPS PDF URLs', () => {
    expect(isSharedPdfUrl('file:///plans/floor.pdf')).toBe(true);
    expect(isSharedPdfUrl('content://provider/plans/floor.PDF?token=1')).toBe(true);
    expect(isSharedPdfUrl('https://example.com/plans/floor.PDF?token=1#page=2')).toBe(true);
  });

  it('rejects insecure and non-PDF links', () => {
    expect(isSharedPdfUrl('http://example.com/floor.pdf')).toBe(false);
    expect(isSharedPdfUrl('https://example.com/floor.png')).toBe(false);
    expect(isSharedPdfUrl('https://example.com/download?file=floor.pdf')).toBe(false);
  });

  it('unwraps PDFs passed through the registered custom scheme', () => {
    const pdfUrl = 'https://example.com/plans/site.pdf?signature=abc';
    const appUrl = `plans-mobile://open?url=${encodeURIComponent(pdfUrl)}`;

    expect(sharedPdfUri(appUrl)).toBe(pdfUrl);
    expect(filenameFromUri(appUrl)).toBe('site.pdf');
  });
});