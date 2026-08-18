import React, { useEffect, useState, useRef } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { renderPageToCanvas } from '../lib/pdfUtils';
import { Loader2 } from 'lucide-react';

export default function PageThumbnails() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, totalPages, currentPage } = state;
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;

    const generateThumbnails = async () => {
      if (!pdfDoc) return;
      const t = [];
      const canvas = document.createElement('canvas');
      
      for (let i = 1; i <= totalPages; i++) {
        if (!mounted) break;
        await renderPageToCanvas(pdfDoc, i, canvas, 0.2); // Low scale for thumb
        t.push(canvas.toDataURL('image/jpeg', 0.8));
      }
      if (mounted) setThumbnails(t);
    };

    generateThumbnails();

    return () => { mounted = false; };
  }, [pdfDoc, totalPages]);

  if (!pdfDoc) {
    return (
      <div className="h-full flex items-center justify-center text-sidebar-foreground/50 text-sm">
        No document loaded
      </div>
    );
  }

  if (thumbnails.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sidebar-foreground/50 text-sm gap-2">
        <Loader2 className="animate-spin" size={24} />
        Generating thumbnails...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4" ref={containerRef}>
      {thumbnails.map((src, index) => {
        const pageNum = index + 1;
        const isActive = currentPage === pageNum;
        return (
          <div 
            key={pageNum}
            className={`flex flex-col items-center cursor-pointer group`}
            onClick={() => dispatch({ type: 'SET_CURRENT_PAGE', page: pageNum })}
          >
            <div className={`relative w-full rounded shadow-sm overflow-hidden transition-all duration-200 border-2 ${
              isActive ? 'border-primary ring-2 ring-primary/20 scale-[1.02]' : 'border-transparent group-hover:border-primary/50'
            }`}>
              <img src={src} alt={`Page ${pageNum}`} className="w-full h-auto bg-white" />
              <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                {pageNum}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
