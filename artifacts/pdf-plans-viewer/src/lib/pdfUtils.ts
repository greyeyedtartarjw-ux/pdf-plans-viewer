import * as pdfjsLib from 'pdfjs-dist';

// Worker is copied to public/ so it is served as a plain static file.
// import.meta.env.BASE_URL ensures the path is correct regardless of the
// proxy base path (e.g. "/" in dev, or a sub-path in production).
(pdfjsLib as any).GlobalWorkerOptions.workerSrc =
  `${import.meta.env.BASE_URL}pdf.worker.min.js`;

export const loadPDF = async (file: File) => {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = (pdfjsLib as any).getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf = await loadingTask.promise;
  return pdf;
};

export const renderPageToCanvas = async (
  pdf: any,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = 1.0
) => {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  // HiDPI: render at device-pixel-ratio, shrink via CSS
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';

  const context = canvas.getContext('2d');
  if (!context) return null;

  const transform = outputScale !== 1
    ? [outputScale, 0, 0, outputScale, 0, 0]
    : undefined;

  await page.render({ canvasContext: context, transform, viewport }).promise;
  return { viewport, page };
};

export const extractTextContent = async (
  pdf: any,
  pageNumber: number
) => {
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();
  return textContent.items.map((item: any) => ({
    str: item.str,
    transform: item.transform,
    width: item.width,
    height: item.height,
  }));
};
