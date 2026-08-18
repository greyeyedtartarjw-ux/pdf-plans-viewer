import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves ?url imports to the correct served path, required for cross-origin worker
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Initialize the worker once at module level
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export const loadPDF = async (file: File) => {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument(new Uint8Array(arrayBuffer));
  const pdf = await loadingTask.promise;
  return pdf;
};

export const renderPageToCanvas = async (
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = 1.0
) => {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  // Set physical pixel size
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";

  const context = canvas.getContext('2d');
  if (!context) return null;

  const transform = outputScale !== 1
    ? [outputScale, 0, 0, outputScale, 0, 0]
    : undefined;

  const renderContext = {
    canvasContext: context,
    transform,
    viewport,
  };

  await page.render(renderContext).promise;
  return { viewport, page };
};

export const extractTextContent = async (
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
) => {
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();
  return textContent.items.map((item: any) => ({
    str: item.str,
    transform: item.transform,
  }));
};
