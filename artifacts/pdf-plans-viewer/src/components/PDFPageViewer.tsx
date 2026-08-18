import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as fabric from 'fabric';
import { useViewerContext } from '../store/ViewerContext';
import { renderPageToCanvas } from '../lib/pdfUtils';
import { initFabricCanvas, applyToolState, generateId } from '../lib/fabricUtils';
import { calculateDistance, calculateArea, formatMeasurement } from '../lib/measurementUtils';
import { THEME } from '../lib/constants';

export default function PDFPageViewer() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, currentPage, zoom, activeTool, highlightColor, scale, annotations, measurements } = state;
  
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const [fCanvas, setFCanvas] = useState<fabric.Canvas | null>(null);
  const [isRenderLoading, setIsRenderLoading] = useState(false);

  // Interaction refs
  const isDrawing = useRef(false);
  const points = useRef<{x: number, y: number}[]>([]);
  const currentShape = useRef<fabric.Object | null>(null);
  const currentLines = useRef<fabric.Line[]>([]);
  
  // Need to communicate scale to click picker if set-scale mode
  const { onSetScalePoint } = (window as any)._viewerCallbacks || {};

  // 1. Render PDF Page
  useEffect(() => {
    let mounted = true;
    
    const renderPage = async () => {
      if (!pdfDoc || !pdfCanvasRef.current) return;
      
      setIsRenderLoading(true);
      try {
        const result = await renderPageToCanvas(pdfDoc, currentPage, pdfCanvasRef.current, zoom);
        if (mounted && result) {
          // Adjust container dimensions
          if (containerRef.current) {
            containerRef.current.style.width = `${result.viewport.width}px`;
            containerRef.current.style.height = `${result.viewport.height}px`;
          }
          
          // Re-init fabric canvas
          if (fCanvas) {
            fCanvas.dispose();
          }
          
          if (fabricCanvasRef.current) {
            fabricCanvasRef.current.width = result.viewport.width;
            fabricCanvasRef.current.height = result.viewport.height;
            const newFCanvas = initFabricCanvas(fabricCanvasRef.current);
            setFCanvas(newFCanvas);
          }
        }
      } catch (err) {
        console.error("Render failed", err);
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
    
    // In a real app we would parse JSON and add back
    // For now we will keep it simple and just rely on the UI actions
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
  }, [fCanvas, currentPage]); // intentionally not including annotations/measurements to prevent re-render loops on add

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
          const points_arr: [number, number, number, number] = [pointer.x, pointer.y, pointer.x, pointer.y];
          const line = new fabric.Line(points_arr, {
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
          // Finish line
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
             // Create label
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
             
             const group = new fabric.Group([currentShape.current!, text], {
               selectable: false
             });
             fCanvas.remove(currentShape.current!);
             fCanvas.add(group);
             
             // Save measurement
             const id = generateId();
             group.set('id', id as any);
             
             dispatch({
               type: 'ADD_MEASUREMENT',
               page: currentPage,
               measurement: {
                 id,
                 pageNumber: currentPage,
                 type: 'distance',
                 label: mData.label,
                 realWorldValue: mData.value,
                 unit: mData.unit,
                 points: [p1, p2],
                 data: group.toObject(['id'] as any)
               }
             });
          }
          currentShape.current = null;
          points.current = [];
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
        
        // Let user edit, we'll save on deselect in a full implementation
        // For simplicity here, we rely on canvas serialization later.
      }
    };

    const handleMouseMove = (o: fabric.TEvent) => {
      if (!isDrawing.current) return;
      const pointer = fCanvas.getScenePoint(o.e as any);

      if (activeTool === 'pan' && containerRef.current && o.e instanceof MouseEvent) {
        // Find the scrollable parent
        const scroller = containerRef.current.parentElement;
        if (scroller) {
          scroller.scrollLeft -= o.e.movementX;
          scroller.scrollTop -= o.e.movementY;
        }
      } else if ((activeTool === 'measure-distance' || activeTool === 'set-scale') && currentShape.current) {
        const line = currentShape.current as fabric.Line;
        line.set({ x2: pointer.x, y2: pointer.y });
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
          
          dispatch({
            type: 'ADD_ANNOTATION',
            page: currentPage,
            annotation: {
              id,
              pageNumber: currentPage,
              type: 'highlight',
              data: currentShape.current.toObject(['id'])
            }
          });
        }
        currentShape.current = null;
        points.current = [];
      }
    };

    fCanvas.on('mouse:down', handleMouseDown);
    fCanvas.on('mouse:move', handleMouseMove);
    fCanvas.on('mouse:up', handleMouseUp);

    return () => {
      fCanvas.off('mouse:down', handleMouseDown);
      fCanvas.off('mouse:move', handleMouseMove);
      fCanvas.off('mouse:up', handleMouseUp);
    };
  }, [fCanvas, activeTool, zoom, scale, highlightColor, currentPage, dispatch]);


  // Handle global key events (delete)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fCanvas, currentPage, dispatch]);


  return (
    <div className="relative shadow-xl bg-white border border-border/50 select-none m-auto transition-transform origin-top-left" ref={containerRef}>
      {/* PDF Canvas Layer */}
      <canvas 
        ref={pdfCanvasRef} 
        className="absolute top-0 left-0 pointer-events-none"
      />
      
      {/* Fabric Draw Layer */}
      <canvas 
        ref={fabricCanvasRef} 
        className="absolute top-0 left-0"
      />

      {isRenderLoading && (
        <div className="absolute inset-0 bg-background/20 backdrop-blur-[2px] flex items-center justify-center z-10">
          <div className="bg-card px-4 py-2 rounded-md shadow-md flex items-center gap-2 border border-border">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
            <span className="text-sm font-medium">Rendering page {currentPage}...</span>
          </div>
        </div>
      )}
    </div>
  );
}
