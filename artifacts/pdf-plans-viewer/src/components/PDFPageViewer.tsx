import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as fabric from 'fabric';
import { useViewerContext } from '../store/ViewerContext';
import { renderPageToCanvas } from '../lib/pdfUtils';
import { initFabricCanvas, applyToolState, generateId } from '../lib/fabricUtils';
import { calculateDistance, calculateArea, formatMeasurement, deduplicatePoints } from '../lib/measurementUtils';
import { THEME } from '../lib/constants';
import {
  createAnnotation,
  deleteAnnotation,
  createMeasurement,
  deleteMeasurement,
} from '@workspace/api-client-react';
import { toast } from '@/hooks/use-toast';

/**
 * Attempt `fn` once; on failure, retry once more. If the second attempt also
 * fails, show a destructive toast with `errorTitle` and the caught message.
 */
async function saveWithRetry<T>(fn: () => Promise<T>, errorTitle: string): Promise<void> {
  try {
    await fn();
  } catch {
    try {
      await fn();
    } catch (err) {
      console.error(errorTitle, err);
      toast({
        variant: 'destructive',
        title: errorTitle,
        description: err instanceof Error ? err.message : 'Please check your connection and try again.',
      });
    }
  }
}

export default function PDFPageViewer() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, currentPage, zoom, activeTool, highlightColor, scale, annotations, measurements, documentId } = state;

  const containerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<HTMLCanvasElement>(null);

  const [fCanvas, setFCanvas] = useState<fabric.Canvas | null>(null);
  const [isRenderLoading, setIsRenderLoading] = useState(false);
  const [areaHint, setAreaHint] = useState<string | null>(null);
  const areaHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDrawing = useRef(false);
  const points = useRef<{ x: number, y: number }[]>([]);
  const currentShape = useRef<fabric.Object | null>(null);
  const areaPreviewLines = useRef<fabric.Line[]>([]);
  const areaLivePreview = useRef<fabric.Line | null>(null);
  const snapRing = useRef<fabric.Circle | null>(null);
  const isSnapping = useRef(false);

  /** Show a transient hint message to the user, auto-dismissed after 2.5 s. */
  const showAreaHint = useCallback((msg: string) => {
    setAreaHint(msg);
    if (areaHintTimer.current) clearTimeout(areaHintTimer.current);
    areaHintTimer.current = setTimeout(() => setAreaHint(null), 2500);
  }, []);

  /** Remove all area-drawing preview objects from the canvas and reset state. */
  const cancelAreaDrawing = useCallback((canvas: fabric.Canvas) => {
    areaPreviewLines.current.forEach(l => canvas.remove(l));
    areaPreviewLines.current = [];
    if (areaLivePreview.current) {
      canvas.remove(areaLivePreview.current);
      areaLivePreview.current = null;
    }
    if (snapRing.current) {
      canvas.remove(snapRing.current);
      snapRing.current = null;
    }
    isSnapping.current = false;
    isDrawing.current = false;
    points.current = [];
    canvas.setCursor('crosshair');
    canvas.renderAll();
  }, []);

  // 1. Render PDF Page
  useEffect(() => {
    let mounted = true;

    const renderPage = async () => {
      if (!pdfDoc || !pdfCanvasRef.current) return;

      setIsRenderLoading(true);
      try {
        const result = await renderPageToCanvas(pdfDoc, currentPage, pdfCanvasRef.current, zoom);
        if (mounted && result) {
          if (containerRef.current) {
            containerRef.current.style.width = `${result.viewport.width}px`;
            containerRef.current.style.height = `${result.viewport.height}px`;
          }
          if (fCanvas) fCanvas.dispose();
          if (fabricCanvasRef.current) {
            fabricCanvasRef.current.width = result.viewport.width;
            fabricCanvasRef.current.height = result.viewport.height;
            const newFCanvas = initFabricCanvas(fabricCanvasRef.current);
            setFCanvas(newFCanvas);
          }
        }
      } catch (err) {
        console.error('Render failed', err);
      } finally {
        if (mounted) setIsRenderLoading(false);
      }
    };

    renderPage();
    return () => { mounted = false; };
  }, [pdfDoc, currentPage, zoom]);

  // 2. Apply saved annotations/measurements when canvas changes
  useEffect(() => {
    if (!fCanvas) return;
    fCanvas.clear();

    const pageAnns = annotations[currentPage] || [];
    pageAnns.forEach(ann => {
      fabric.util.enlivenObjects([ann.data]).then((objects: any[]) => {
        objects.forEach(obj => {
          obj.id = ann.id;
          fCanvas.add(obj);
        });
      });
    });

    const pageMeas = measurements[currentPage] || [];
    pageMeas.forEach(m => {
      fabric.util.enlivenObjects([m.data]).then((objects: any[]) => {
        objects.forEach(obj => {
          obj.id = m.id;
          fCanvas.add(obj);
        });
      });
    });

    fCanvas.renderAll();
  }, [fCanvas, currentPage]);

  // 3. Handle Tool Changes
  useEffect(() => {
    if (!fCanvas) return;
    applyToolState(fCanvas, activeTool);
  }, [activeTool, fCanvas]);

  // 4. Canvas Events
  useEffect(() => {
    if (!fCanvas) return;

    const handleMouseDown = (o: fabric.TEvent) => {
      const pointer = fCanvas.getScenePoint(o.e as any);

      if (activeTool === 'pan') {
        isDrawing.current = true;
        fCanvas.setCursor('grabbing');
      } else if (activeTool === 'measure-distance' || activeTool === 'set-scale') {
        if (!isDrawing.current) {
          isDrawing.current = true;
          points.current = [pointer];
          const pts: [number, number, number, number] = [pointer.x, pointer.y, pointer.x, pointer.y];
          const line = new fabric.Line(pts, {
            strokeWidth: 2 / zoom,
            fill: THEME.colors.measurement.line,
            stroke: THEME.colors.measurement.line,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
          });
          currentShape.current = line;
          fCanvas.add(line);
        } else {
          isDrawing.current = false;
          points.current.push(pointer);
          const p1 = points.current[0];
          const p2 = points.current[1];
          const pxDist = calculateDistance(p1, p2);

          if (activeTool === 'set-scale') {
            fCanvas.remove(currentShape.current!);
            if ((window as any)._setScaleCallback) {
              (window as any)._setScaleCallback(pxDist / zoom);
            }
          } else {
            const mData = formatMeasurement(pxDist / zoom, scale, false);
            const text = new fabric.Text(mData.label, {
              left: (p1.x + p2.x) / 2,
              top: (p1.y + p2.y) / 2,
              fontSize: 14 / zoom,
              fontFamily: 'monospace',
              fill: THEME.colors.measurement.text,
              backgroundColor: 'white',
              originX: 'center',
              originY: 'center',
              selectable: false,
            });
            const group = new fabric.Group([currentShape.current!, text], { selectable: false });
            fCanvas.remove(currentShape.current!);
            fCanvas.add(group);

            const id = generateId();
            group.set('id', id as any);

            const measurement = {
              id,
              pageNumber: currentPage,
              type: 'distance' as const,
              label: mData.label,
              realWorldValue: mData.value,
              unit: mData.unit,
              points: [p1, p2],
              data: group.toObject(['id'] as any),
            };
            dispatch({ type: 'ADD_MEASUREMENT', page: currentPage, measurement });

            if (documentId) {
              saveWithRetry(
                () => createMeasurement(documentId, {
                  id,
                  pageNumber: currentPage,
                  type: 'distance',
                  label: mData.label,
                  realWorldValue: mData.value,
                  unit: mData.unit,
                  points: [p1, p2],
                  fabricData: group.toObject(['id'] as any) as unknown as Record<string, unknown>,
                }),
                'Measurement not saved',
              );
            }
          }
          currentShape.current = null;
          points.current = [];
        }
      } else if (activeTool === 'measure-area') {
        if (!isDrawing.current) {
          isDrawing.current = true;
          points.current = [pointer];
        } else {
          // Draw a segment from the previous point to this new point
          const lastPt = points.current[points.current.length - 1];
          const seg = new fabric.Line([lastPt.x, lastPt.y, pointer.x, pointer.y], {
            strokeWidth: 2 / zoom,
            stroke: THEME.colors.measurement.line,
            fill: THEME.colors.measurement.line,
            selectable: false,
            evented: false,
          });
          areaPreviewLines.current.push(seg);
          fCanvas.add(seg);
          points.current.push(pointer);
          fCanvas.renderAll();
          // Polygon closed via double-click (handled in dblclick event)
        }
      } else if (activeTool === 'highlight') {
        isDrawing.current = true;
        points.current = [pointer];
        const rect = new fabric.Rect({
          left: pointer.x,
          top: pointer.y,
          width: 0,
          height: 0,
          fill: highlightColor,
          selectable: false,
          evented: false,
        });
        currentShape.current = rect;
        fCanvas.add(rect);
      } else if (activeTool === 'text' || activeTool === 'note') {
        const text = new fabric.IText('Text note...', {
          left: pointer.x,
          top: pointer.y,
          fontSize: 16 / zoom,
          fontFamily: 'Inter, sans-serif',
          fill: activeTool === 'note' ? '#eab308' : '#334155',
          backgroundColor: activeTool === 'note' ? '#fef08a' : 'transparent',
          padding: 4,
          selectable: true,
        });
        const id = generateId();
        text.set('id', id as any);
        fCanvas.add(text);
        fCanvas.setActiveObject(text);
        text.enterEditing();
        text.selectAll();

        // Save on exit editing
        text.on('editing:exited', () => {
          const fabricData = text.toObject() as unknown as Record<string, unknown>;
          const annotation = {
            id,
            pageNumber: currentPage,
            type: (activeTool === 'note' ? 'note' : 'text') as 'note' | 'text',
            data: fabricData,
          };
          dispatch({ type: 'ADD_ANNOTATION', page: currentPage, annotation });
          if (documentId) {
            saveWithRetry(
              () => createAnnotation(documentId, {
                id,
                pageNumber: currentPage,
                type: annotation.type,
                fabricData,
              }),
              'Annotation not saved',
            );
          }
        });
      }
    };

    const handleMouseMove = (o: fabric.TEvent) => {
      if (!isDrawing.current) return;
      const pointer = fCanvas.getScenePoint(o.e as any);

      if (activeTool === 'pan' && containerRef.current && o.e instanceof MouseEvent) {
        const scroller = containerRef.current.parentElement;
        if (scroller) {
          scroller.scrollLeft -= o.e.movementX;
          scroller.scrollTop -= o.e.movementY;
        }
      } else if ((activeTool === 'measure-distance' || activeTool === 'set-scale') && currentShape.current) {
        const line = currentShape.current as fabric.Line;
        line.set({ x2: pointer.x, y2: pointer.y });
        fCanvas.renderAll();
      } else if (activeTool === 'measure-area' && points.current.length > 0) {
        // Snap detection: check if cursor is within 12 screen-px of the first point.
        // Need ≥3 placed points so closing the polygon yields a valid area.
        const firstPt = points.current[0];
        const snapThresholdPx = 12 / zoom; // convert screen px → scene units
        const dx = pointer.x - firstPt.x;
        const dy = pointer.y - firstPt.y;
        const distToFirst = Math.sqrt(dx * dx + dy * dy);
        const canSnap = points.current.length >= 3 && distToFirst <= snapThresholdPx;

        // Add / remove snap ring around the first point
        if (canSnap) {
          if (!snapRing.current) {
            const ring = new fabric.Circle({
              left: firstPt.x,
              top: firstPt.y,
              radius: 9 / zoom,
              fill: 'rgba(59, 130, 246, 0.18)',
              stroke: THEME.colors.measurement.line,
              strokeWidth: 2 / zoom,
              originX: 'center',
              originY: 'center',
              selectable: false,
              evented: false,
            });
            snapRing.current = ring;
            fCanvas.add(ring);
          }
          isSnapping.current = true;
          fCanvas.setCursor('pointer');
        } else {
          if (snapRing.current) {
            fCanvas.remove(snapRing.current);
            snapRing.current = null;
          }
          isSnapping.current = false;
          fCanvas.setCursor('crosshair');
        }

        // Live-preview dashed line: snap endpoint to first point when in range
        const targetPt = canSnap ? firstPt : pointer;
        if (areaLivePreview.current) {
          fCanvas.remove(areaLivePreview.current);
        }
        const lastPt = points.current[points.current.length - 1];
        const liveLine = new fabric.Line([lastPt.x, lastPt.y, targetPt.x, targetPt.y], {
          strokeWidth: 2 / zoom,
          stroke: THEME.colors.measurement.line,
          fill: THEME.colors.measurement.line,
          strokeDashArray: [6 / zoom, 4 / zoom],
          selectable: false,
          evented: false,
        });
        areaLivePreview.current = liveLine;
        fCanvas.add(liveLine);
        fCanvas.renderAll();
      } else if (activeTool === 'highlight' && currentShape.current) {
        const rect = currentShape.current as fabric.Rect;
        const start = points.current[0];
        rect.set({
          left: Math.min(start.x, pointer.x),
          top: Math.min(start.y, pointer.y),
          width: Math.abs(pointer.x - start.x),
          height: Math.abs(pointer.y - start.y),
        });
        fCanvas.renderAll();
      }
    };

    const handleMouseUp = () => {
      if (activeTool === 'pan') {
        isDrawing.current = false;
        fCanvas.setCursor('grab');
      } else if (activeTool === 'highlight' && isDrawing.current) {
        isDrawing.current = false;
        if (currentShape.current) {
          const id = generateId();
          currentShape.current.set('id', id as any);
          currentShape.current.set('selectable', false);

          const annotation = {
            id,
            pageNumber: currentPage,
            type: 'highlight' as const,
            data: currentShape.current.toObject(['id']),
          };
          dispatch({ type: 'ADD_ANNOTATION', page: currentPage, annotation });

          if (documentId) {
            saveWithRetry(
              () => createAnnotation(documentId, {
                id,
                pageNumber: currentPage,
                type: 'highlight',
                fabricData: currentShape.current!.toObject(['id']),
              }),
              'Highlight not saved',
            );
          }
        }
        currentShape.current = null;
        points.current = [];
      }
    };

    const handleDblClick = (o: fabric.TEvent) => {
      if (activeTool !== 'measure-area' || !isDrawing.current) return;

      // A dblclick fires two mousedown events at the (approximately) same position
      // before the dblclick event itself. Deduplicate consecutive near-identical
      // points so closing works correctly regardless of exact event timing or
      // pointer behavior.
      const pts = deduplicatePoints(points.current);
      if (pts.length < 3) {
        showAreaHint('Need at least 3 distinct points to measure an area — keep clicking to add more.');
        return;
      }

      // Clear all preview objects
      areaPreviewLines.current.forEach(l => fCanvas.remove(l));
      areaPreviewLines.current = [];
      if (areaLivePreview.current) {
        fCanvas.remove(areaLivePreview.current);
        areaLivePreview.current = null;
      }
      if (snapRing.current) {
        fCanvas.remove(snapRing.current);
        snapRing.current = null;
      }
      isSnapping.current = false;
      fCanvas.setCursor('crosshair');

      // Compute area in pixel² (canvas coords, already at zoom scale)
      const pxArea = calculateArea(pts);
      const mData = formatMeasurement(pxArea / Math.pow(zoom, 2), scale, true);

      // Centroid for the label
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

      const polygon = new fabric.Polygon(pts.map(p => ({ x: p.x, y: p.y })), {
        fill: 'rgba(59, 130, 246, 0.15)',
        stroke: THEME.colors.measurement.line,
        strokeWidth: 2 / zoom,
        selectable: false,
        evented: false,
      });

      const label = new fabric.Text(mData.label, {
        left: cx,
        top: cy,
        fontSize: 14 / zoom,
        fontFamily: 'monospace',
        fill: THEME.colors.measurement.text,
        backgroundColor: 'white',
        originX: 'center',
        originY: 'center',
        selectable: false,
      });

      const group = new fabric.Group([polygon, label], { selectable: false });
      fCanvas.add(group);

      const id = generateId();
      group.set('id', id as any);

      const measurement = {
        id,
        pageNumber: currentPage,
        type: 'area' as const,
        label: mData.label,
        realWorldValue: mData.value,
        unit: mData.unit,
        points: pts,
        data: group.toObject(['id'] as any),
      };
      dispatch({ type: 'ADD_MEASUREMENT', page: currentPage, measurement });

      if (documentId) {
        saveWithRetry(
          () => createMeasurement(documentId, {
            id,
            pageNumber: currentPage,
            type: 'area',
            label: mData.label,
            realWorldValue: mData.value,
            unit: mData.unit,
            points: pts,
            fabricData: group.toObject(['id'] as any) as unknown as Record<string, unknown>,
          }),
          'Measurement not saved',
        );
      }

      // Reset area drawing state
      isDrawing.current = false;
      points.current = [];
      currentShape.current = null;
      fCanvas.renderAll();
    };

    fCanvas.on('mouse:down', handleMouseDown);
    fCanvas.on('mouse:move', handleMouseMove);
    fCanvas.on('mouse:up', handleMouseUp);
    fCanvas.on('mouse:dblclick', handleDblClick);

    return () => {
      fCanvas.off('mouse:down', handleMouseDown);
      fCanvas.off('mouse:move', handleMouseMove);
      fCanvas.off('mouse:up', handleMouseUp);
      fCanvas.off('mouse:dblclick', handleDblClick);
    };
  }, [fCanvas, activeTool, zoom, scale, highlightColor, currentPage, dispatch, documentId, deduplicatePoints, showAreaHint, cancelAreaDrawing]);

  // 5. Delete / Escape key handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape cancels an in-progress area measurement
      if (e.key === 'Escape') {
        if (fCanvas && activeTool === 'measure-area' && isDrawing.current) {
          cancelAreaDrawing(fCanvas);
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (fCanvas && fCanvas.getActiveObject()) {
          const activeObj = fCanvas.getActiveObject();
          if (activeObj) {
            const id = (activeObj as any).id;
            fCanvas.remove(activeObj);
            fCanvas.discardActiveObject();
            if (id) {
              dispatch({ type: 'REMOVE_ANNOTATION', page: currentPage, id });
              dispatch({ type: 'REMOVE_MEASUREMENT', page: currentPage, id });
              if (documentId) {
                saveWithRetry(
                  () => deleteAnnotation(documentId, id),
                  'Could not delete annotation',
                );
                saveWithRetry(
                  () => deleteMeasurement(documentId, id),
                  'Could not delete measurement',
                );
              }
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fCanvas, activeTool, currentPage, dispatch, documentId, cancelAreaDrawing]);

  return (
    <div className="relative shadow-xl bg-white border border-border/50 select-none m-auto transition-transform origin-top-left" ref={containerRef}>
      <canvas ref={pdfCanvasRef} className="absolute top-0 left-0 pointer-events-none" />
      <canvas ref={fabricCanvasRef} className="absolute top-0 left-0" />
      {isRenderLoading && (
        <div className="absolute inset-0 bg-background/20 backdrop-blur-[2px] flex items-center justify-center z-10">
          <div className="bg-card px-4 py-2 rounded-md shadow-md flex items-center gap-2 border border-border">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
            <span className="text-sm font-medium">Rendering page {currentPage}…</span>
          </div>
        </div>
      )}
      {areaHint && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="bg-card/95 border border-border text-foreground text-xs font-medium px-3 py-2 rounded-md shadow-lg backdrop-blur-sm">
            {areaHint}
          </div>
        </div>
      )}
    </div>
  );
}
