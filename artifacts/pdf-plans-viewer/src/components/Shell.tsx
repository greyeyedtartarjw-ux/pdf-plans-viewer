import React, { useRef, useState, useEffect } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import PDFPageViewer from './PDFPageViewer';
import EmptyState from './EmptyState';
import ScaleDialog from './ScaleDialog';
import { loadPDF } from '../lib/pdfUtils';
import html2canvas from 'html2canvas';

export default function Shell() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, scale } = state;
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [showScaleDialog, setShowScaleDialog] = useState(false);
  const [pixelDistanceToScale, setPixelDistanceToScale] = useState(0);

  // Expose callback for scale tool
  useEffect(() => {
    (window as any)._setScaleCallback = (pxDistance: number) => {
      setPixelDistanceToScale(pxDistance);
      setShowScaleDialog(true);
    };
    return () => {
      delete (window as any)._setScaleCallback;
    };
  }, []);

  const handleFileSelect = async (file: File) => {
    try {
      const doc = await loadPDF(file);
      
      // Generate simple hash for localstorage key
      const hash = `${file.name}-${file.size}`;
      
      dispatch({
        type: 'SET_PDF_DOC',
        doc,
        data: { name: file.name, size: file.size, hash },
        totalPages: doc.numPages
      });
      
    } catch (err) {
      console.error("Error loading PDF", err);
      alert("Failed to load PDF file.");
    }
  };

  const handleSnapshot = async () => {
    const viewerElement = document.getElementById('pdf-viewer-area');
    if (!viewerElement) return;
    
    try {
      const canvas = await html2canvas(viewerElement, {
        scale: 2, // High res
        backgroundColor: '#ffffff'
      });
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot-page-${state.currentPage}-${Date.now()}.png`;
      a.click();
    } catch (err) {
      console.error("Snapshot failed", err);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleSetScale = () => {
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'set-scale' });
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'search' });
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
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
          if (e.target.files && e.target.files[0]) {
            handleFileSelect(e.target.files[0]);
          }
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
          {!pdfDoc ? (
            <EmptyState onFileSelect={handleFileSelect} />
          ) : (
            <div 
              className="flex-1 overflow-auto bg-muted p-8 print:p-0 print:bg-white print:overflow-visible flex items-start justify-center"
              style={{
                // Let ctrl+wheel trigger zoom natively if possible, or handle via event listeners
              }}
            >
              <div id="pdf-viewer-area" className="print:shadow-none print:border-none">
                <PDFPageViewer />
              </div>
            </div>
          )}
          
          {/* Status bar */}
          <footer className="h-7 bg-sidebar border-t border-border flex items-center px-4 justify-between text-[11px] text-sidebar-foreground/70 font-mono select-none z-10 shrink-0">
            <div className="flex gap-4">
              <span>Ready</span>
              {pdfDoc && <span>{state.documentData?.name}</span>}
              {pdfDoc && <span>Page {state.currentPage} / {state.totalPages}</span>}
            </div>
            <div className="flex gap-4">
              {state.activeTool === 'set-scale' && <span className="text-primary font-bold">Pick 2 points to set scale...</span>}
              <span>Scale: {scale.set ? `1 ${scale.unit} = ${(1/scale.pixelsPerUnit).toFixed(4)} ${scale.realWorldUnit}` : 'Not set'}</span>
              <span>Zoom: {Math.round(state.zoom * 100)}%</span>
            </div>
          </footer>
        </main>
      </div>

      {showScaleDialog && (
        <ScaleDialog 
          onClose={() => setShowScaleDialog(false)} 
          pixelDistance={pixelDistanceToScale} 
        />
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
