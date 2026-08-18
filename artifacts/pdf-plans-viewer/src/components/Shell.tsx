import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import PDFPageViewer from './PDFPageViewer';
import EmptyState from './EmptyState';
import ScaleDialog from './ScaleDialog';
import { loadPDF } from '../lib/pdfUtils';
import html2canvas from 'html2canvas';
import {
  upsertDocument,
  listAnnotations,
  listMeasurements,
  getDocumentScale,
  setDocumentScale,
  getShare,
} from '@workspace/api-client-react';
import type { Scale, Annotation, Measurement } from '../types';

// Map API annotation → local Annotation shape
function mapApiAnnotations(apiAnns: Awaited<ReturnType<typeof listAnnotations>>): Record<number, Annotation[]> {
  const result: Record<number, Annotation[]> = {};
  for (const a of apiAnns) {
    if (!result[a.pageNumber]) result[a.pageNumber] = [];
    result[a.pageNumber].push({ id: a.id, pageNumber: a.pageNumber, type: a.type, data: a.fabricData });
  }
  return result;
}

// Map API measurement → local Measurement shape
function mapApiMeasurements(apiMeas: Awaited<ReturnType<typeof listMeasurements>>): Record<number, Measurement[]> {
  const result: Record<number, Measurement[]> = {};
  for (const m of apiMeas) {
    if (!result[m.pageNumber]) result[m.pageNumber] = [];
    result[m.pageNumber].push({
      id: m.id,
      pageNumber: m.pageNumber,
      type: m.type,
      label: m.label,
      realWorldValue: m.realWorldValue,
      unit: m.unit,
      points: m.points as { x: number; y: number }[],
      data: m.fabricData,
    });
  }
  return result;
}

// Map API ScaleConfig → local Scale shape
function mapApiScale(apiScale: Awaited<ReturnType<typeof getDocumentScale>>): Scale {
  return {
    set: apiScale.isSet,
    pixelsPerUnit: apiScale.pixelsPerUnit,
    unit: apiScale.unit,
    realWorldUnit: apiScale.realWorldUnit,
  };
}

export default function Shell() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, scale, documentId } = state;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showScaleDialog, setShowScaleDialog] = useState(false);
  const [pixelDistanceToScale, setPixelDistanceToScale] = useState(0);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  // Expose callback for scale tool
  useEffect(() => {
    (window as any)._setScaleCallback = (pxDistance: number) => {
      setPixelDistanceToScale(pxDistance);
      setShowScaleDialog(true);
    };
    return () => { delete (window as any)._setScaleCallback; };
  }, []);

  // ── On startup: resolve ?share=TOKEN from URL ──────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('share');
    if (!token) return;

    dispatch({ type: 'SET_SYNCING', syncing: true });
    getShare(token)
      .then((payload) => {
        dispatch({
          type: 'LOAD_REMOTE_STATE',
          documentId: payload.document.id,
          annotations: mapApiAnnotations(payload.annotations),
          measurements: mapApiMeasurements(payload.measurements),
          scale: mapApiScale(payload.scale),
          shareToken: token,
        });
        setShareMsg(`Shared view loaded for "${payload.document.name}". Open that PDF file to see the drawing.`);
      })
      .catch(() => {
        dispatch({ type: 'SET_SYNCING', syncing: false });
        setShareMsg('Share link is invalid or has expired.');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist scale to API when it changes ──────────────────────────────────
  useEffect(() => {
    if (!documentId || !scale.set) return;
    setDocumentScale(documentId, {
      isSet: scale.set,
      pixelsPerUnit: scale.pixelsPerUnit,
      unit: scale.unit,
      realWorldUnit: scale.realWorldUnit,
    }).catch(console.error);
  }, [documentId, scale]);

  // ── Load a PDF file ───────────────────────────────────────────────────────
  const handleFileSelect = useCallback(async (file: File) => {
    try {
      const doc = await loadPDF(file);
      const hash = `${file.name}-${file.size}`;

      dispatch({
        type: 'SET_PDF_DOC',
        doc,
        data: { name: file.name, size: file.size, hash },
        totalPages: doc.numPages,
      });

      // Register (or re-find) the document on the server
      const serverDoc = await upsertDocument({ name: file.name, hash });
      dispatch({ type: 'SET_DOCUMENT_ID', documentId: serverDoc.id });

      // Load persisted annotations, measurements, scale in parallel
      const [apiAnnotations, apiMeasurements, apiScale] = await Promise.all([
        listAnnotations(serverDoc.id),
        listMeasurements(serverDoc.id),
        getDocumentScale(serverDoc.id),
      ]);

      dispatch({
        type: 'LOAD_REMOTE_STATE',
        documentId: serverDoc.id,
        annotations: mapApiAnnotations(apiAnnotations),
        measurements: mapApiMeasurements(apiMeasurements),
        scale: mapApiScale(apiScale),
      });

      setShareMsg(null);
    } catch (err) {
      console.error('Error loading PDF', err);
      alert('Failed to load PDF file.');
    }
  }, [dispatch]);

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const handleSnapshot = async () => {
    const viewerElement = document.getElementById('pdf-viewer-area');
    if (!viewerElement) return;
    try {
      const canvas = await html2canvas(viewerElement, { scale: 2, backgroundColor: '#ffffff' });
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot-page-${state.currentPage}-${Date.now()}.png`;
      a.click();
    } catch (err) {
      console.error('Snapshot failed', err);
    }
  };

  const handlePrint = () => window.print();

  const handleSetScale = () => dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'set-scale' });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'search' });
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'h' || e.key === 'H') dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'pan' });
      if (e.key === 'v' || e.key === 'V') dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'select' });
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [dispatch]);

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden font-sans">
      <input
        type="file"
        accept="application/pdf"
        ref={fileInputRef}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) handleFileSelect(e.target.files[0]);
        }}
      />

      <Toolbar
        onOpenClick={() => fileInputRef.current?.click()}
        onSnapshot={handleSnapshot}
        onPrint={handlePrint}
        onSetScale={handleSetScale}
      />

      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar />

        <main className="flex-1 flex flex-col relative bg-muted/40">
          {/* Share / status banner */}
          {shareMsg && (
            <div className="bg-primary/10 border-b border-primary/20 px-4 py-2 text-xs text-primary font-medium flex justify-between items-center">
              <span>{shareMsg}</span>
              <button onClick={() => setShareMsg(null)} className="ml-4 opacity-70 hover:opacity-100 text-base leading-none">×</button>
            </div>
          )}

          {!pdfDoc ? (
            <EmptyState onFileSelect={handleFileSelect} />
          ) : (
            <div id="pdf-scroll-container" className="flex-1 overflow-auto bg-muted p-8 print:p-0 print:bg-white print:overflow-visible flex items-start justify-center">
              <div id="pdf-viewer-area" className="print:shadow-none print:border-none">
                <PDFPageViewer />
              </div>
            </div>
          )}

          {/* Status bar */}
          <footer className="h-7 bg-sidebar border-t border-border flex items-center px-4 justify-between text-[11px] text-sidebar-foreground/70 font-mono select-none z-10 shrink-0">
            <div className="flex gap-4">
              <span>{state.isSyncing ? 'Syncing…' : 'Ready'}</span>
              {pdfDoc && <span>{state.documentData?.name}</span>}
              {pdfDoc && <span>Page {state.currentPage} / {state.totalPages}</span>}
              {documentId && <span className="text-primary/60">doc#{documentId}</span>}
            </div>
            <div className="flex gap-4">
              {state.activeTool === 'set-scale' && <span className="text-primary font-bold">Pick 2 points to set scale…</span>}
              <span>Scale: {scale.set ? `1 ${scale.unit} = ${(1 / scale.pixelsPerUnit).toFixed(4)} ${scale.realWorldUnit}` : 'Not set'}</span>
              <span>Zoom: {Math.round(state.zoom * 100)}%</span>
            </div>
          </footer>
        </main>
      </div>

      {showScaleDialog && (
        <ScaleDialog onClose={() => setShowScaleDialog(false)} pixelDistance={pixelDistanceToScale} />
      )}

      {/* Print styles */}
      <style>{`
        @media print {
          @page { size: auto; margin: 0; }
          body * { visibility: hidden; }
          #pdf-viewer-area, #pdf-viewer-area * { visibility: visible; }
          #pdf-viewer-area { position: absolute; left: 0; top: 0; }
        }
      `}</style>
    </div>
  );
}
