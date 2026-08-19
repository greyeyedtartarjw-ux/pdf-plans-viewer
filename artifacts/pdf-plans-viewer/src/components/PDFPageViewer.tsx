import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as fabric from 'fabric';
import { useViewerContext } from '../store/ViewerContext';
import { renderPageToCanvas } from '../lib/pdfUtils';
import { initFabricCanvas, applyToolState, generateId } from '../lib/fabricUtils';
import { rebuildFabricPage } from '../lib/fabricPageState';
import { calculateDistance, calculateArea, formatMeasurement, deduplicatePoints, resolveSnapPoint } from '../lib/measurementUtils';
import { THEME } from '../lib/constants';
import {
  createAnnotation,
  deleteAnnotation,
  createMeasurement,
  deleteMeasurement,
} from '@workspace/api-client-react';
import { toast } from '@/hooks/use-toast';
import {
  addPendingOp,
  comparePendingOps,
  getPendingOps,
  nextPendingSequence,
  removePendingOp,
  type PendingOp,
} from '../lib/pendingQueue';

/**
 * Return true when an HTTP error status should never be retried.
 * 4xx errors (except 429 Too Many Requests) are client errors that a retry
 * cannot fix. 409 Conflict in particular signals the record already exists.
 */
function isNonRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

export default function PDFPageViewer() {
  const { state, dispatch } = useViewerContext();
  const {
    pdfDoc, currentPage, zoom, activeTool, highlightColor, scale,
    annotations, measurements, documentId, serverUnreachable, remoteStateRevision,
  } = state;

  const containerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<HTMLCanvasElement>(null);

  const [fCanvas, setFCanvas] = useState<fabric.Canvas | null>(null);
  const [isRenderLoading, setIsRenderLoading] = useState(false);
  const [hasRenderedPage, setHasRenderedPage] = useState(false);
  const [areaHint, setAreaHint] = useState<string | null>(null);
  const areaHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isAreaDrawingActive, setIsAreaDrawingActive] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    setIsTouchDevice(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsTouchDevice(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── Save status tracking refs ──────────────────────────────────────────────
  // saveInFlight:        API calls currently awaiting a server response.
  // failureQueueCount:   saves queued for retry (not yet retried successfully).
  // terminalFailureCount: non-retryable (4xx) failures — data not persisted;
  //                       stays > 0 for the lifetime of the page so the user
  //                       cannot close thinking "Saved" when a change is lost.
  //   Priority: (terminalFailureCount|failureQueueCount) > saveInFlight > saved.
  const saveInFlight = useRef(0);
  const failureQueueCount = useRef(0);
  const terminalFailureCount = useRef(0);
  const savedClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always-current dispatch ref so the retry callback — set up once on mount —
  // can dispatch status updates without needing to be recreated.
  const dispatchRef = useRef(dispatch);
  useEffect(() => { dispatchRef.current = dispatch; });

  // Single source of truth for save-status transitions. Reads the refs above
  // and dispatches the appropriate status. Call after mutating any count ref.
  const recomputeStatus = useCallback(() => {
    // Cancel any pending idle-clear timer — it may no longer be accurate.
    if (savedClearTimer.current) {
      clearTimeout(savedClearTimer.current);
      savedClearTimer.current = null;
    }
    if (terminalFailureCount.current > 0 || failureQueueCount.current > 0) {
      // Unsaved changes remain — stay on 'failed' regardless of concurrent successes.
      dispatchRef.current({ type: 'SET_SAVE_STATUS', status: 'failed' });
    } else if (saveInFlight.current > 0) {
      dispatchRef.current({ type: 'SET_SAVE_STATUS', status: 'saving' });
    } else {
      // All in-flight saves resolved and nothing queued: show 'saved', then clear.
      dispatchRef.current({ type: 'SET_SAVE_STATUS', status: 'saved' });
      savedClearTimer.current = setTimeout(() => {
        dispatchRef.current({ type: 'SET_SAVE_STATUS', status: 'idle' });
      }, 3000);
    }
  }, []); // stable — only reads refs and dispatchRef

  // ── Causal save queue ─────────────────────────────────────────────────────
  // Every annotation/measurement operation is persisted at user-action time,
  // before its request starts. The in-memory entry supplies the request
  // function; localStorage supplies the durable ordering across reloads.
  const failedSaves = useRef<Array<{ fn: () => Promise<unknown>; errorTitle: string; pendingOp?: PendingOp }>>([]);
  const isProcessingSaves = useRef(false);

  const isAlreadyApplied = useCallback((op: PendingOp, error: unknown) => {
    const status = error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
    return (op.opType === 'create_annotation' || op.opType === 'create_measurement')
      ? status === 409
      : status === 404;
  }, []);

  const processPendingSaves = useCallback(async () => {
    if (serverUnreachable || isProcessingSaves.current) return;
    isProcessingSaves.current = true;
    let stoppedOnFailure = false;

    try {
      while (true) {
        // Entries can have been completed by Shell's persistent flusher.
        failedSaves.current = failedSaves.current.filter((entry) => {
          if (!entry.pendingOp) return true;
          return getPendingOps(entry.pendingOp.documentId).some((op) =>
            op.id === entry.pendingOp!.id
            && op.opType === entry.pendingOp!.opType
            && op.sequence === entry.pendingOp!.sequence,
          );
        });

        const entry = [...failedSaves.current].sort((left, right) => {
          if (!left.pendingOp || !right.pendingOp) return 0;
          return comparePendingOps(left.pendingOp, right.pendingOp);
        })[0];
        if (!entry) break;

        const op = entry.pendingOp;
        if (op) {
          const firstPersisted = getPendingOps(op.documentId)[0];
          // A prior operation from another session must be flushed by Shell
          // before this session can safely send a later dependent action.
          if (
            !firstPersisted
            || firstPersisted.id !== op.id
            || firstPersisted.opType !== op.opType
            || firstPersisted.sequence !== op.sequence
          ) {
            stoppedOnFailure = true;
            failureQueueCount.current = failedSaves.current.length;
            recomputeStatus();
            break;
          }
        }

        saveInFlight.current++;
        recomputeStatus();
        let completed = false;
        try {
          await entry.fn();
          completed = true;
        } catch (firstError) {
          if (op && isAlreadyApplied(op, firstError)) {
            completed = true;
          } else if (!isNonRetryable(firstError)) {
            try {
              await entry.fn();
              completed = true;
            } catch (retryError) {
              completed = Boolean(op && isAlreadyApplied(op, retryError));
            }
          }
        } finally {
          saveInFlight.current--;
        }

        if (!completed) {
          stoppedOnFailure = true;
          failureQueueCount.current = failedSaves.current.length;
          recomputeStatus();
          toast({
            variant: 'destructive',
            title: 'Unable to save — server is unreachable',
            description: 'Your work is queued and will sync when the connection is restored.',
          });
          break;
        }

        if (op) removePendingOp(op.documentId, op.id, op.opType);
        failedSaves.current = failedSaves.current.filter((candidate) => candidate !== entry);
        failureQueueCount.current = 0;
        recomputeStatus();
      }
    } finally {
      isProcessingSaves.current = false;
    }

    if (stoppedOnFailure) {
      throw new Error('Pending changes could not be synchronized');
    }
  }, [isAlreadyApplied, recomputeStatus, serverUnreachable]);

  // Keep a ref to saveWithRetry so the window callback (set up once) always
  // calls the latest version, which captures the current serverUnreachable value.
  const saveWithRetryRef = useRef<(fn: () => Promise<unknown>, errorTitle: string, pendingOp?: PendingOp) => Promise<void>>(
    async () => {}
  );

  useEffect(() => {
    (window as any)._pendingRetryCount = () => failedSaves.current.length;
    (window as any)._retryFailedSaves = async () => {
      const before = failedSaves.current.length;
      await processPendingSaves();
      if (failedSaves.current.length > 0) {
        throw new Error('Pending changes could not be synchronized');
      }
      if (before > 0) {
        toast({
          title: 'Changes saved',
          description: 'All previously unsaved changes have been saved successfully.',
        });
      }
    };
    return () => {
      delete (window as any)._pendingRetryCount;
      delete (window as any)._retryFailedSaves;
    };
  }, [processPendingSaves]);

  // ── Connectivity-aware save helper ────────────────────────────────────────
  // When the server is unreachable, skips the API call, shows an explicit
  // "unable to save" error, and queues the operation for retry when the
  // server comes back. Otherwise retries once on transient failure.
  //
  // Save status is derived entirely from saveInFlight and failureQueueCount via
  // recomputeStatus, ensuring queued failures can never be overwritten by a
  // concurrent unrelated success.
  const saveWithRetry = useCallback(async (
    fn: () => Promise<unknown>,
    errorTitle: string,
    pendingOp?: PendingOp,
  ): Promise<void> => {
    if (pendingOp) {
      // Durable action-time enqueueing is required so a later successful
      // delete remains ordered behind an earlier unresolved create.
      addPendingOp(pendingOp);
      failedSaves.current = [
        ...failedSaves.current.filter((entry) =>
          !entry.pendingOp
          || entry.pendingOp.id !== pendingOp.id
          || entry.pendingOp.opType !== pendingOp.opType,
        ),
        { fn, errorTitle, pendingOp },
      ];

      if (serverUnreachable) {
        failureQueueCount.current = failedSaves.current.length;
        recomputeStatus();
        toast({
          variant: 'destructive',
          title: 'Unable to save — server is unreachable',
          description: 'Your work is queued and will sync when the connection is restored.',
        });
        return;
      }

      try {
        await processPendingSaves();
      } catch {
        // The queued change is intentionally left durable for reconnect/manual
        // retry; drawing event handlers must not receive an unhandled rejection.
      }
      return;
    }

    if (serverUnreachable) {
      toast({
        variant: 'destructive',
        title: 'Unable to save — server is unreachable',
        description: 'Your work is visible on screen. It will be queued for retry when the connection is restored.',
      });
      failedSaves.current.push({ fn, errorTitle });
      failureQueueCount.current++;
      recomputeStatus(); // → 'failed'
      return;
    }

    saveInFlight.current++;
    recomputeStatus(); // → 'saving'

    try {
      await fn();
      saveInFlight.current--;
      recomputeStatus(); // → 'saved' if no queued failures remain
    } catch (firstErr) {
      if (isNonRetryable(firstErr)) {
        console.error(errorTitle, firstErr);
        toast({
          variant: 'destructive',
          title: errorTitle,
          description: firstErr instanceof Error ? firstErr.message : 'Please check your connection and try again.',
        });
        // Non-retryable mutations are not queued, but they still represent
        // local work that is not on the server. Keep the failure visible so a
        // user cannot close the document after seeing a misleading "Saved".
        terminalFailureCount.current++;
        saveInFlight.current--;
        recomputeStatus();
        return;
      }
      try {
        await fn();
        saveInFlight.current--;
        recomputeStatus(); // → 'saved' if no queued failures remain
      } catch (err) {
        console.error(errorTitle, err);
        // Queue for retry — the server may have gone down between our health check and this call
        failedSaves.current.push({ fn, errorTitle });
        failureQueueCount.current++;
        saveInFlight.current--;
        recomputeStatus(); // → 'failed' (queued failure takes priority)
        toast({
          variant: 'destructive',
          title: 'Unable to save — server is unreachable',
          description: 'Your work is visible on screen and has been queued for retry.',
        });
      }
    }
  }, [processPendingSaves, recomputeStatus, serverUnreachable]);

  // Shell uses this bridge for saves that originate outside the canvas, such
  // as scale calibration. It deliberately points at the latest helper so its
  // connectivity state and queue are shared with annotation saves.
  useEffect(() => {
    saveWithRetryRef.current = saveWithRetry;
    (window as any)._saveWithStatus = (fn: () => Promise<unknown>, errorTitle: string, pendingOp?: PendingOp) =>
      saveWithRetryRef.current(fn, errorTitle, pendingOp);
    return () => {
      delete (window as any)._saveWithStatus;
    };
  }, [saveWithRetry]);

  const isDrawing = useRef(false);
  const points = useRef<{ x: number, y: number }[]>([]);
  const currentShape = useRef<fabric.Object | null>(null);
  const areaPreviewLines = useRef<fabric.Line[]>([]);
  const areaLivePreview = useRef<fabric.Line | null>(null);
  const areaLiveLabel = useRef<fabric.Text | null>(null);
  const snapRing = useRef<fabric.Circle | null>(null);
  const isSnapping = useRef(false);

  /** Show a transient hint message to the user, auto-dismissed after 3 s. */
  const showAreaHint = useCallback((msg: string) => {
    setAreaHint(msg);
    if (areaHintTimer.current) clearTimeout(areaHintTimer.current);
    areaHintTimer.current = setTimeout(() => setAreaHint(null), 3000);
  }, []);

  /** Remove all area-drawing preview objects from the canvas and reset state. */
  const cancelAreaDrawing = useCallback((canvas: fabric.Canvas) => {
    areaPreviewLines.current.forEach(l => canvas.remove(l));
    areaPreviewLines.current = [];
    if (areaLivePreview.current) {
      canvas.remove(areaLivePreview.current);
      areaLivePreview.current = null;
    }
    setIsAreaDrawingActive(false);
    if (areaLiveLabel.current) {
      canvas.remove(areaLiveLabel.current);
      areaLiveLabel.current = null;
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
      if (!pdfDoc || !pdfCanvasRef.current) {
        setHasRenderedPage(false);
        return;
      }

      setIsRenderLoading(true);
      setHasRenderedPage(false);
      try {
        const result = await renderPageToCanvas(pdfDoc, currentPage, pdfCanvasRef.current, zoom);
        if (mounted && result) {
          if (containerRef.current) {
            containerRef.current.style.width = `${result.viewport.width}px`;
            containerRef.current.style.height = `${result.viewport.height}px`;
          }
          // The PDF canvas is ready at this point. Yield one frame before
          // initializing the annotation overlay so the rendered plan can paint
          // immediately instead of waiting for Fabric setup.
          setHasRenderedPage(true);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (!mounted) return;
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
        if (mounted) setHasRenderedPage(false);
      } finally {
        if (mounted) setIsRenderLoading(false);
      }
    };

    renderPage();
    return () => { mounted = false; };
  }, [pdfDoc, currentPage, zoom]);

  // 2. Apply a loaded remote/offline snapshot after Fabric has initialized.
  // Local drawing updates already modify the active Fabric canvas directly, so
  // this revision changes only when Shell replaces state during recovery/hydration.
  useEffect(() => {
    if (!fCanvas) return;
    let cancelled = false;

    void rebuildFabricPage(
      fCanvas,
      annotations,
      measurements,
      currentPage,
      (serialized) => fabric.util.enlivenObjects(serialized),
      () => cancelled,
    ).catch((error) => {
      if (!cancelled) console.error('Could not restore saved page objects', error);
    });

    return () => {
      cancelled = true;
    };
  }, [fCanvas, currentPage, remoteStateRevision]);

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
              const fabricData = group.toObject(['id'] as any) as unknown as Record<string, unknown>;
              saveWithRetry(
                () => createMeasurement(documentId, {
                  id,
                  pageNumber: currentPage,
                  type: 'distance',
                  label: mData.label,
                  realWorldValue: mData.value,
                  unit: mData.unit,
                  points: [p1, p2],
                  fabricData,
                }),
                'Measurement not saved',
                {
                  opType: 'create_measurement',
                  documentId,
                  id,
                  pageNumber: currentPage,
                  type: 'distance',
                  label: mData.label,
                  realWorldValue: mData.value,
                  unit: mData.unit,
                  points: [p1, p2],
                  fabricData,
                  timestamp: Date.now(),
                  sequence: nextPendingSequence(),
                },
              );
            }
          }
          currentShape.current = null;
          points.current = [];
        }
      } else if (activeTool === 'measure-area') {
        if (!isDrawing.current) {
          isDrawing.current = true;
          setIsAreaDrawingActive(true);
          points.current = [pointer];
          showAreaHint(
            isTouchDevice
              ? 'Tap to add points · Double-tap to close shape'
              : 'Backspace to undo last point · Escape to cancel',
          );
        } else {
          // Resolve the effective point: snap to the first point when within
          // the snap radius so the stored coordinate matches the visual preview.
          const firstPt = points.current[0];
          const snapThresholdPx = 12 / zoom;
          const effectivePt = resolveSnapPoint(pointer, firstPt, snapThresholdPx, points.current.length);

          // Draw a segment from the previous point to this new (effective) point
          const lastPt = points.current[points.current.length - 1];
          const seg = new fabric.Line([lastPt.x, lastPt.y, effectivePt.x, effectivePt.y], {
            strokeWidth: 2 / zoom,
            stroke: THEME.colors.measurement.line,
            fill: THEME.colors.measurement.line,
            selectable: false,
            evented: false,
          });
          areaPreviewLines.current.push(seg);
          fCanvas.add(seg);
          points.current.push(effectivePt);
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
              {
                opType: 'create_annotation',
                documentId,
                id,
                pageNumber: currentPage,
                type: annotation.type,
                fabricData,
                timestamp: Date.now(),
                sequence: nextPendingSequence(),
              },
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
        // Snap detection: use resolveSnapPoint (same logic as handleMouseDown)
        // to determine whether the cursor is close enough to the first point.
        const firstPt = points.current[0];
        const snapThresholdPx = 12 / zoom; // convert screen px → scene units
        const resolvedPt = resolveSnapPoint(pointer, firstPt, snapThresholdPx, points.current.length);
        const canSnap = resolvedPt === firstPt; // identity check: snapped iff resolveSnapPoint returned firstPt

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

        // Live-preview dashed line: use the same resolved point as mousedown will use
        const targetPt = resolvedPt;
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

        // Show a running area estimate when ≥3 points would form a polygon
        const potentialPts = [...points.current, targetPt];
        if (potentialPts.length >= 3) {
          const pxArea = calculateArea(potentialPts);
          const mData = formatMeasurement(pxArea / Math.pow(zoom, 2), scale, true);
          const cx = potentialPts.reduce((s, p) => s + p.x, 0) / potentialPts.length;
          const cy = potentialPts.reduce((s, p) => s + p.y, 0) / potentialPts.length;

          if (areaLiveLabel.current) {
            fCanvas.remove(areaLiveLabel.current);
          }
          const liveLabel = new fabric.Text(`~${mData.label}`, {
            left: cx,
            top: cy,
            fontSize: 13 / zoom,
            fontFamily: 'monospace',
            fill: THEME.colors.measurement.text,
            backgroundColor: 'rgba(255,255,255,0.85)',
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
          });
          areaLiveLabel.current = liveLabel;
          fCanvas.add(liveLabel);
        } else if (areaLiveLabel.current) {
          fCanvas.remove(areaLiveLabel.current);
          areaLiveLabel.current = null;
        }

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

          // Capture serialised data NOW before currentShape is nulled below.
          // The closure must close over an immutable value so retry works correctly.
          const fabricData = currentShape.current.toObject(['id']);
          if (documentId) {
            saveWithRetry(
              () => createAnnotation(documentId, {
                id,
                pageNumber: currentPage,
                type: 'highlight',
                fabricData,
              }),
              'Highlight not saved',
              {
                opType: 'create_annotation',
                documentId,
                id,
                pageNumber: currentPage,
                type: 'highlight',
                fabricData,
                timestamp: Date.now(),
                sequence: nextPendingSequence(),
              },
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
      if (areaLiveLabel.current) {
        fCanvas.remove(areaLiveLabel.current);
        areaLiveLabel.current = null;
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
        const areaFabricData = group.toObject(['id'] as any) as unknown as Record<string, unknown>;
        saveWithRetry(
          () => createMeasurement(documentId, {
            id,
            pageNumber: currentPage,
            type: 'area',
            label: mData.label,
            realWorldValue: mData.value,
            unit: mData.unit,
            points: pts,
            fabricData: areaFabricData,
          }),
          'Measurement not saved',
          {
            opType: 'create_measurement',
            documentId,
            id,
            pageNumber: currentPage,
            type: 'area',
            label: mData.label,
            realWorldValue: mData.value,
            unit: mData.unit,
            points: pts,
            fabricData: areaFabricData,
            timestamp: Date.now(),
            sequence: nextPendingSequence(),
          },
        );
      }

      // Reset area drawing state
      isDrawing.current = false;
      setIsAreaDrawingActive(false);
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
  }, [fCanvas, activeTool, zoom, scale, highlightColor, currentPage, dispatch, documentId, deduplicatePoints, showAreaHint, cancelAreaDrawing, saveWithRetry, isTouchDevice]);

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

      // Backspace or Ctrl/Cmd+Z while drawing an area: undo the last placed point
      if (
        fCanvas &&
        activeTool === 'measure-area' &&
        isDrawing.current &&
        (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey)))
      ) {
        e.preventDefault();
        if (points.current.length <= 1) {
          // Only the first point remains — cancel the whole shape
          cancelAreaDrawing(fCanvas);
        } else {
          // Pop the last point and its corresponding segment line
          points.current = points.current.slice(0, -1);
          const lastSeg = areaPreviewLines.current.pop();
          if (lastSeg) fCanvas.remove(lastSeg);
          // The live-preview line will snap back on the next mouse:move automatically
          fCanvas.renderAll();
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
                  {
                    opType: 'delete_annotation',
                    documentId,
                    id,
                    timestamp: Date.now(),
                    sequence: nextPendingSequence(),
                  },
                );
                saveWithRetry(
                  () => deleteMeasurement(documentId, id),
                  'Could not delete measurement',
                  {
                    opType: 'delete_measurement',
                    documentId,
                    id,
                    timestamp: Date.now(),
                    sequence: nextPendingSequence(),
                  },
                );
              }
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fCanvas, activeTool, currentPage, dispatch, documentId, cancelAreaDrawing, saveWithRetry]);

  /** Undo the last placed area point — mirrors the Backspace keyboard handler. */
  const undoLastAreaPoint = useCallback(() => {
    if (!fCanvas || !isDrawing.current) return;
    if (points.current.length <= 1) {
      cancelAreaDrawing(fCanvas);
    } else {
      points.current = points.current.slice(0, -1);
      const lastSeg = areaPreviewLines.current.pop();
      if (lastSeg) fCanvas.remove(lastSeg);
      fCanvas.renderAll();
    }
  }, [fCanvas, cancelAreaDrawing]);

  const cancelActiveAreaDrawing = useCallback(() => {
    if (fCanvas && isDrawing.current) cancelAreaDrawing(fCanvas);
  }, [fCanvas, cancelAreaDrawing]);

  return (
    <div
      className="relative shadow-xl bg-white border border-border/50 select-none m-auto transition-transform origin-top-left"
      data-page-rendered={hasRenderedPage ? 'true' : 'false'}
      ref={containerRef}
    >
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
      {isTouchDevice && isAreaDrawingActive && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-20 flex gap-2">
          <button
            onPointerDown={(e) => { e.stopPropagation(); undoLastAreaPoint(); }}
            className="bg-card/95 border border-border text-foreground text-sm font-medium px-4 py-2 rounded-md shadow-lg backdrop-blur-sm active:bg-muted touch-manipulation"
          >
            ↩ Undo point
          </button>
          <button
            onPointerDown={(e) => { e.stopPropagation(); cancelActiveAreaDrawing(); }}
            className="bg-destructive/90 border border-destructive text-destructive-foreground text-sm font-medium px-4 py-2 rounded-md shadow-lg backdrop-blur-sm active:bg-destructive touch-manipulation"
          >
            ✕ Cancel
          </button>
        </div>
      )}
    </div>
  );
}
