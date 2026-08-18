import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { renderPageToCanvas } from '../lib/pdfUtils';
import { Loader2 } from 'lucide-react';

interface ScrollInfo {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
}

interface DragState {
  startMouseX: number;
  startMouseY: number;
  startScrollLeft: number;
  startScrollTop: number;
  rx: number;
  ry: number;
}

function getScrollContainer(): HTMLElement | null {
  return document.getElementById('pdf-scroll-container');
}

export default function PageThumbnails() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, totalPages, currentPage, zoom } = state;
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbImgRefs = useRef<(HTMLImageElement | null)[]>([]);
  const dragRef = useRef<DragState | null>(null);

  const [scrollInfo, setScrollInfo] = useState<ScrollInfo>({
    scrollLeft: 0, scrollTop: 0, clientWidth: 0, clientHeight: 0,
  });

  // ── Thumbnail generation ────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const generate = async () => {
      if (!pdfDoc) return;
      const canvas = document.createElement('canvas');
      const t: string[] = [];
      for (let i = 1; i <= totalPages; i++) {
        if (!mounted) break;
        await renderPageToCanvas(pdfDoc, i, canvas, 0.2);
        t.push(canvas.toDataURL('image/jpeg', 0.8));
      }
      if (mounted) setThumbnails(t);
    };
    generate();
    return () => { mounted = false; };
  }, [pdfDoc, totalPages]);

  // ── Scroll tracking ─────────────────────────────────────────────────────────
  const readScroll = useCallback(() => {
    const el = getScrollContainer();
    if (!el) return;
    setScrollInfo({
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    });
  }, []);

  useEffect(() => {
    const el = getScrollContainer();
    if (!el) return;
    el.addEventListener('scroll', readScroll, { passive: true });
    const ro = new ResizeObserver(readScroll);
    ro.observe(el);
    readScroll();
    return () => {
      el.removeEventListener('scroll', readScroll);
      ro.disconnect();
    };
  }, [readScroll]);

  // Re-read on zoom / page navigation (content size changes without scroll event)
  useEffect(() => { readScroll(); }, [zoom, currentPage, readScroll]);

  // ── Viewport rect computation ───────────────────────────────────────────────
  const computeViewportRect = useCallback(
    (imgEl: HTMLImageElement | null): { left: number; top: number; width: number; height: number; rx: number; ry: number } | null => {
      const sc = getScrollContainer();
      if (!imgEl || !sc || !imgEl.naturalWidth || !imgEl.clientWidth) return null;

      const thumbW = imgEl.clientWidth;
      const thumbH = imgEl.clientHeight;

      // Natural dims of thumbnail were rendered at scale=0.2 → compute page size at current zoom
      const pageW = (imgEl.naturalWidth / 0.2) * zoom;
      const pageH = (imgEl.naturalHeight / 0.2) * zoom;

      // Pixels-per-viewer-pixel in thumbnail space
      const rx = thumbW / pageW;
      const ry = thumbH / pageH;

      // Where is the page content relative to the scroll container's scroll origin?
      // getBoundingClientRect gives positions in viewport; adjust for scroll offset.
      const scRect = sc.getBoundingClientRect();
      const contentEl = sc.querySelector('#pdf-viewer-area') as HTMLElement | null;
      let contentOffsetX = 0;
      let contentOffsetY = 0;
      if (contentEl) {
        const cRect = contentEl.getBoundingClientRect();
        contentOffsetX = cRect.left - scRect.left + sc.scrollLeft;
        contentOffsetY = cRect.top - scRect.top + sc.scrollTop;
      }

      // Visible page region in page-pixel coordinates
      const vpLeft = sc.scrollLeft - contentOffsetX;
      const vpTop = sc.scrollTop - contentOffsetY;

      const left = Math.max(0, Math.min(vpLeft * rx, thumbW));
      const top = Math.max(0, Math.min(vpTop * ry, thumbH));
      const width = Math.max(4, Math.min(sc.clientWidth * rx, thumbW - left));
      const height = Math.max(4, Math.min(sc.clientHeight * ry, thumbH - top));

      return { left, top, width, height, rx, ry };
    },
    // scrollInfo in deps so rect recomputes when scroll changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollInfo, zoom],
  );

  // ── Drag-to-scroll on the viewport indicator ────────────────────────────────
  const handleIndicatorMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, imgEl: HTMLImageElement | null) => {
      e.preventDefault();
      e.stopPropagation();
      const sc = getScrollContainer();
      if (!sc || !imgEl) return;

      const rect = computeViewportRect(imgEl);
      if (!rect) return;

      dragRef.current = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startScrollLeft: sc.scrollLeft,
        startScrollTop: sc.scrollTop,
        rx: rect.rx,
        ry: rect.ry,
      };

      const onMove = (me: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = (me.clientX - d.startMouseX) / d.rx;
        const dy = (me.clientY - d.startMouseY) / d.ry;
        sc.scrollLeft = d.startScrollLeft + dx;
        sc.scrollTop = d.startScrollTop + dy;
      };

      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [computeViewportRect],
  );

  // ── Click on thumbnail background (outside indicator) to scroll there ───────
  const handleThumbnailClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, pageNum: number, imgEl: HTMLImageElement | null) => {
      // Navigate to page
      dispatch({ type: 'SET_CURRENT_PAGE', page: pageNum });

      // If clicking on the active page, jump scroll to clicked position
      if (pageNum === currentPage && imgEl) {
        const sc = getScrollContainer();
        if (!sc) return;
        const rect = computeViewportRect(imgEl);
        if (!rect) return;

        // Click position relative to the thumbnail image
        const imgRect = imgEl.getBoundingClientRect();
        const clickX = e.clientX - imgRect.left;
        const clickY = e.clientY - imgRect.top;

        // Convert to page-pixel coordinates and center viewport there
        const targetPageX = clickX / rect.rx;
        const targetPageY = clickY / rect.ry;
        const contentEl = sc.querySelector('#pdf-viewer-area') as HTMLElement | null;
        let contentOffsetX = 0;
        let contentOffsetY = 0;
        if (contentEl) {
          const scRect = sc.getBoundingClientRect();
          const cRect = contentEl.getBoundingClientRect();
          contentOffsetX = cRect.left - scRect.left + sc.scrollLeft;
          contentOffsetY = cRect.top - scRect.top + sc.scrollTop;
        }
        sc.scrollLeft = contentOffsetX + targetPageX - sc.clientWidth / 2;
        sc.scrollTop = contentOffsetY + targetPageY - sc.clientHeight / 2;
      }
    },
    [dispatch, currentPage, computeViewportRect],
  );

  // ── Render ──────────────────────────────────────────────────────────────────
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
        Generating thumbnails…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4" ref={containerRef}>
      {thumbnails.map((src, index) => {
        const pageNum = index + 1;
        const isActive = currentPage === pageNum;
        const imgEl = thumbImgRefs.current[index] ?? null;
        const vpRect = isActive ? computeViewportRect(imgEl) : null;

        return (
          <div
            key={pageNum}
            className="flex flex-col items-center cursor-pointer group"
            onClick={(e) => handleThumbnailClick(e, pageNum, imgEl)}
          >
            <div
              className={`relative w-full rounded shadow-sm overflow-hidden transition-all duration-200 border-2 ${
                isActive
                  ? 'border-primary ring-2 ring-primary/20 scale-[1.02]'
                  : 'border-transparent group-hover:border-primary/50'
              }`}
            >
              <img
                src={src}
                alt={`Page ${pageNum}`}
                className="w-full h-auto bg-white block"
                ref={(el) => { thumbImgRefs.current[index] = el; }}
                // Force re-render of vpRect after image loads
                onLoad={readScroll}
                draggable={false}
              />

              {/* Viewport indicator for the active page */}
              {isActive && vpRect && (
                <div
                  className="absolute pointer-events-auto"
                  style={{
                    left: vpRect.left,
                    top: vpRect.top,
                    width: vpRect.width,
                    height: vpRect.height,
                    border: '2px solid rgba(59, 130, 246, 0.9)',
                    background: 'rgba(59, 130, 246, 0.12)',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.4) inset',
                    cursor: 'grab',
                    boxSizing: 'border-box',
                  }}
                  onMouseDown={(e) => handleIndicatorMouseDown(e, imgEl)}
                  // Prevent thumbnail click from firing when dragging indicator
                  onClick={(e) => e.stopPropagation()}
                  title="Drag to scroll"
                />
              )}

              <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-mono pointer-events-none">
                {pageNum}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
