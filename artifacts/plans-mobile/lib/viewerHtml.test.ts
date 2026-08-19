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

  it('renders a calibration guide while choosing points and preserves the locked line', () => {
    const html = createViewerHtml('file:///app/assets/pdf.min.txt', 'file:///app/assets/pdf.worker.min.txt');

    expect(html).toContain("mode==='calibrate'");
    expect(html).toContain("overlayCanvas.addEventListener('touchmove'");
    expect(html).toContain("drawCalibrationLine(currentPoints[0],calibrationPreviewPoint,'#FFFFFF',true)");
    expect(html).toContain("drawCalibrationLine(currentPoints[0],currentPoints[1],'#FFB020',false)");
    expect(html).toContain("if(mode==='calibrate'&&currentPoints.length>=2) return;");
    expect(html).toContain('case \'clearCurrentPoints\': currentPoints=[]; calibrationPreviewPoint=null; drawOverlay(); break;');
  });
});
