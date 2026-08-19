import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import PDFPageViewer from './PDFPageViewer';
import EmptyState from './EmptyState';
import ScaleDialog from './ScaleDialog';
import { loadPDF } from '../lib/pdfUtils';
import { getDocumentContentHash, getLegacyDocumentKey } from '../lib/documentIdentity';
import { exportMeasurementsCSV, exportBackupJSON } from '../lib/exportUtils';
import { mergePendingState } from '../lib/pendingState';
import html2canvas from 'html2canvas';
import {
  upsertDocument,
  listAnnotations,
  listMeasurements,
  getDocumentScale,
  setDocumentScale,
  getShare,
  createAnnotation,
  deleteAnnotation,
  createMeasurement,
  deleteMeasurement,
  updateMeasurement,
  useHealthCheck,
  getHealthCheckQueryKey,
} from '@workspace/api-client-react';
import type { Scale, Annotation, Measurement } from '../types';
import {
  recalculatePixelMeasurement,
  updateFabricMeasurementLabel,
} from '../lib/measurementUtils';
import {
  addPendingOp,
  getCachedDocumentId,
  getPendingOps,
  countPendingOps,
  flushPendingOps,
  nextPendingSequence,
  QUEUE_CHANGED_EVENT,
  removeCachedDocumentId,
  setCachedDocumentId,
  type PendingOp,
} from '../lib/pendingQueue';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';

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

/** Tools that are passive (viewing/navigating). Active drawing tools are everything else. */
const PASSIVE_TOOLS = new Set(['pan', 'select']);
const DEFAULT_SCALE: Scale = { set: false, pixelsPerUnit: 1, unit: 'px', realWorldUnit: 'px' };

export default function Shell() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, scale, documentId, activeTool } = state;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showScaleDialog, setShowScaleDialog] = useState(false);
  const [pixelDistanceToScale, setPixelDistanceToScale] = useState(0);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  // ── Connectivity check ────────────────────────────────────────────────────
  // Poll the health endpoint every 15 s. Banner is shown while the server is
  // unreachable and dismissed automatically when it comes back — no manual
  // close so users cannot accidentally hide an active outage.
  const { isError: serverUnreachable, isSuccess: serverReachable } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 15_000, retry: 1 },
  });
  // Track whether the banner has been shown at least once so we don't flash it
  // on initial load before the first health check completes.
  const [serverChecked, setServerChecked] = useState(false);
  useEffect(() => {
    if (serverUnreachable || serverReachable) setServerChecked(true);
  }, [serverUnreachable, serverReachable]);
  const showServerWarning = serverChecked && serverUnreachable;

  // ── Sync connectivity state into ViewerContext ─────────────────────────────
  const prevServerUnreachable = useRef<boolean>(false);
  useEffect(() => {
    if (!serverChecked) return;
    dispatch({ type: 'SET_SERVER_UNREACHABLE', unreachable: !!serverUnreachable });
    prevServerUnreachable.current = !!serverUnreachable;
  }, [serverUnreachable, serverChecked, dispatch]);

  // ── Modal: server dropped while user is actively drawing ──────────────────
  const [showOutageModal, setShowOutageModal] = useState(false);
  const wasDrawingRef = useRef(false);

  // Detect transition: reachable → unreachable while in a drawing tool
  useEffect(() => {
    if (!serverChecked) return;
    if (serverUnreachable && !PASSIVE_TOOLS.has(activeTool)) {
      // Server just went down (or we confirmed it's down) during active drawing
      setShowOutageModal(true);
      wasDrawingRef.current = true;
    }
  // We deliberately only react when serverUnreachable changes, not activeTool
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUnreachable, serverChecked]);

  // Dismiss outage modal when server comes back
  useEffect(() => {
    if (serverReachable && showOutageModal) {
      setShowOutageModal(false);
    }
  }, [serverReachable, showOutageModal]);

  // ── Retry failed saves when server comes back ──────────────────────────────
  const [showRetryBanner, setShowRetryBanner] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retrySuccess, setRetrySuccess] = useState<boolean | null>(null);

  // ── Persistent pending-op count ────────────────────────────────────────────
  // Tracks how many operations are queued in localStorage for the current document.
  // Updated whenever the queue changes (load, flush, retry).
  const [pendingCount, setPendingCount] = useState(0);
  const needsRemoteHydrationRef = useRef(false);

  // ── Flush localStorage pending queue to the server ────────────────────────
  // Called after reconnect or immediately after a file is loaded when the server
  // is already reachable and the queue is non-empty (e.g. after a page reload
  // while there were unsaved changes). Operations are sent in queue order. If
  // one operation fails, later operations wait for the next retry so a delete
  // can never overtake an unresolved create.
  const flushLocalPendingQueue = useCallback(async (docId: number) => {
    const result = await flushPendingOps(
      docId,
      async (op: PendingOp) => {
        if (op.opType === 'create_annotation') {
          await createAnnotation(op.documentId, {
            id: op.id,
            pageNumber: op.pageNumber,
            type: op.type as any,
            fabricData: op.fabricData,
          });
        } else if (op.opType === 'delete_annotation') {
          await deleteAnnotation(op.documentId, op.id);
        } else if (op.opType === 'create_measurement') {
          await createMeasurement(op.documentId, {
            id: op.id,
            pageNumber: op.pageNumber,
            type: op.type as any,
            label: op.label,
            realWorldValue: op.realWorldValue,
            unit: op.unit,
            points: op.points,
            fabricData: op.fabricData,
          });
        } else if (op.opType === 'delete_measurement') {
          await deleteMeasurement(op.documentId, op.id);
        } else if (op.opType === 'update_measurement') {
          await updateMeasurement(op.documentId, op.id, {
            label: op.label,
            realWorldValue: op.realWorldValue,
            unit: op.unit,
            fabricData: op.fabricData,
          });
        } else if (op.opType === 'set_scale') {
          await setDocumentScale(op.documentId, {
            isSet: op.isSet,
            pixelsPerUnit: op.pixelsPerUnit,
            unit: op.unit,
            realWorldUnit: op.realWorldUnit,
          });
        }
      },
      (op, error) => {
        const status = error && typeof error === 'object' && 'status' in error
          ? (error as { status?: unknown }).status
          : undefined;
        // A lost response can leave a create/delete already applied on the
        // server. Treat those idempotent outcomes as success.
        return (
          (op.opType === 'create_annotation' || op.opType === 'create_measurement')
            ? status === 409
            : status === 404
        );
      },
    );
    setPendingCount(result.remaining);

    if (!result.failed && result.succeeded > 0) {
      setRetrySuccess(true);
      setShowRetryBanner(true);
    } else if (result.failed) {
      // Leave banner showing so the user can retry manually
      setRetrySuccess(false);
      setShowRetryBanner(true);
    }
    return result;
  }, []);

  /**
   * Convert legacy pixel measurements as soon as calibration is saved. Local
   * state is updated first so labels redraw immediately; failed API updates
   * are durable queue entries and replay after reconnect or reload.
   */
  const handleScaleSaved = useCallback((savedScale: Scale) => {
    if (documentId) {
      // Queue first so a lost request cannot discard a calibration. The flush
      // replays scale before later recalculated measurement updates.
      addPendingOp({
        opType: 'set_scale',
        documentId,
        id: 'scale',
        isSet: savedScale.set,
        pixelsPerUnit: savedScale.pixelsPerUnit,
        unit: savedScale.unit,
        realWorldUnit: savedScale.realWorldUnit,
        timestamp: Date.now(),
        sequence: nextPendingSequence(),
      });
      setPendingCount(countPendingOps(documentId));
      void flushLocalPendingQueue(documentId).catch((error) => {
        console.error('Could not save scale', error);
      });
    }

    const pixelMeasurements = Object.entries(state.measurements).flatMap(
      ([page, measurements]) =>
        measurements
          .filter((measurement) => measurement.unit === 'px' || measurement.unit === 'px²')
          .map((measurement) => ({ page: Number(page), measurement })),
    );

    for (const { page, measurement } of pixelMeasurements) {
      const values = recalculatePixelMeasurement(measurement, savedScale);
      const fabricData = updateFabricMeasurementLabel(measurement.data, values.label);
      dispatch({
        type: 'UPDATE_MEASUREMENT_VALUES',
        page,
        id: measurement.id,
        ...values,
        data: fabricData,
      });

      if (!documentId) continue;

      const queueUpdate = () => {
        addPendingOp({
          opType: 'update_measurement',
          documentId,
          id: measurement.id,
          pageNumber: page,
          ...values,
          fabricData,
          timestamp: Date.now(),
          sequence: nextPendingSequence(),
        });
        setPendingCount(countPendingOps(documentId));
        setRetrySuccess(false);
        setShowRetryBanner(true);
      };

      if (serverUnreachable) {
        queueUpdate();
        continue;
      }

      updateMeasurement(documentId, measurement.id, {
        ...values,
        fabricData,
      }).catch((error) => {
        console.error('Could not recalculate measurement', error);
        queueUpdate();
      });
    }
  }, [
    dispatch,
    documentId,
    flushLocalPendingQueue,
    serverUnreachable,
    state.measurements,
  ]);

  /** Restore queued local work without requiring the API to be reachable. */
  const restoreOfflinePendingState = useCallback((docId: number) => {
    const pendingOps = getPendingOps(docId);
    const merged = mergePendingState({}, {}, pendingOps, DEFAULT_SCALE);
    dispatch({
      type: 'LOAD_REMOTE_STATE',
      documentId: docId,
      annotations: merged.annotations,
      measurements: merged.measurements,
      scale: merged.scale ?? DEFAULT_SCALE,
    });
    setPendingCount(pendingOps.length);
    needsRemoteHydrationRef.current = true;
    return pendingOps.length;
  }, [dispatch]);

  /** Refresh remote state after an offline reopen, preserving queued local work. */
  const hydrateRemoteDocument = useCallback(async (docId: number) => {
    const [apiAnnotations, apiMeasurements, apiScale] = await Promise.all([
      listAnnotations(docId),
      listMeasurements(docId),
      getDocumentScale(docId),
    ]);
    const pendingOps = getPendingOps(docId);
    const remoteScale = mapApiScale(apiScale);
    const merged = mergePendingState(
      mapApiAnnotations(apiAnnotations),
      mapApiMeasurements(apiMeasurements),
      pendingOps,
      remoteScale,
    );
    dispatch({
      type: 'LOAD_REMOTE_STATE',
      documentId: docId,
      annotations: merged.annotations,
      measurements: merged.measurements,
      scale: merged.scale ?? remoteScale,
    });
    setPendingCount(pendingOps.length);
    needsRemoteHydrationRef.current = false;
    return pendingOps.length;
  }, [dispatch]);

  // PDFPageViewer updates this event whenever an operation is added or removed
  // from localStorage, so the indicator changes immediately during the session.
  useEffect(() => {
    const handleQueueChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: number; count: number }>).detail;
      if (documentId && detail?.documentId === documentId) {
        setPendingCount(detail.count);
      }
    };
    window.addEventListener(QUEUE_CHANGED_EVENT, handleQueueChanged);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, handleQueueChanged);
  }, [documentId]);

  // When server recovers after an outage, first hydrate an offline-reopened
  // document, then flush its persistent queue.
  useEffect(() => {
    if (!serverReachable) return;

    // In-memory queue (operations that failed during this session)
    const inMemoryPending = (window as any)._pendingRetryCount?.() ?? 0;
    if (inMemoryPending > 0 || wasDrawingRef.current) {
      setShowRetryBanner(true);
    }
    wasDrawingRef.current = false;

    const resumeDocument = async () => {
      if (!documentId) return;
      try {
        if (needsRemoteHydrationRef.current) {
          await hydrateRemoteDocument(documentId);
        }
        if (countPendingOps(documentId) > 0) {
          await flushLocalPendingQueue(documentId);
        }
      } catch (error) {
        console.error('Could not resume document sync', error);
        setRetrySuccess(false);
        setShowRetryBanner(true);
      }
    };
    void resumeDocument();
  }, [serverReachable, documentId, hydrateRemoteDocument, flushLocalPendingQueue]);

  const handleRetry = useCallback(async () => {
    const retryFn = (window as any)._retryFailedSaves;
    setIsRetrying(true);
    setRetrySuccess(null);
    let failed = false;
    let attempted = false;
    try {
      if (documentId && needsRemoteHydrationRef.current) {
        attempted = true;
        try {
          await hydrateRemoteDocument(documentId);
        } catch (error) {
          console.error('Could not refresh document state', error);
          failed = true;
        }
      }

      if (retryFn) {
        attempted = true;
        try {
          await retryFn();
        } catch {
          failed = true;
        }
      }

      if (documentId && countPendingOps(documentId) > 0) {
        attempted = true;
        const result = await flushLocalPendingQueue(documentId);
        if (result.failed || result.remaining > 0) failed = true;
      }

      if (!attempted) {
        setShowRetryBanner(false);
      } else {
        setRetrySuccess(!failed);
      }
    } catch (error) {
      console.error('Could not retry pending changes', error);
      setRetrySuccess(false);
      setShowRetryBanner(true);
    } finally {
      setIsRetrying(false);
    }
  }, [documentId, flushLocalPendingQueue, hydrateRemoteDocument]);

  // Switch to pan tool when user dismisses outage modal
  const handleOutageModalClose = useCallback(() => {
    setShowOutageModal(false);
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'pan' });
  }, [dispatch]);

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

  // ── Load a PDF file ───────────────────────────────────────────────────────
  const handleFileSelect = useCallback(async (file: File) => {
    let resolvedDocumentId: number | null = null;
    try {
      const doc = await loadPDF(file);
      const hash = await getDocumentContentHash(file);
      // Name-and-size mappings from older releases can collide across
      // different PDFs, so they are intentionally discarded rather than
      // migrated to the content digest.
      removeCachedDocumentId(getLegacyDocumentKey(file));
      resolvedDocumentId = getCachedDocumentId(hash);

      dispatch({
        type: 'SET_PDF_DOC',
        doc,
        data: { name: file.name, size: file.size, hash },
        totalPages: doc.numPages,
      });

      // Register (or re-find) the document on the server, then cache that ID
      // against this local PDF hash for a future offline reopen.
      const serverDoc = await upsertDocument({ name: file.name, hash });
      resolvedDocumentId = serverDoc.id;
      setCachedDocumentId(hash, serverDoc.id);
      const queued = await hydrateRemoteDocument(serverDoc.id);

      // If the server is reachable right now, flush the queue immediately
      // (covers the case where the user reloads after a connectivity gap that
      // has since resolved).
      if (queued > 0 && !serverUnreachable) {
        flushLocalPendingQueue(serverDoc.id);
      }

      setShareMsg(null);
    } catch (err) {
      console.error('Error loading PDF', err);
      // If this PDF has previously been registered, restore its pending local
      // work immediately instead of discarding it just because the server is
      // still unavailable. Remote annotations will hydrate automatically when
      // connectivity returns.
      if (resolvedDocumentId) {
        const queued = restoreOfflinePendingState(resolvedDocumentId);
        setShareMsg(
          queued > 0
            ? `Working offline — restored ${queued} unsaved change${queued === 1 ? '' : 's'}. They will sync when the connection returns.`
            : 'Working offline — this plan will refresh when the connection returns.',
        );
        return;
      }
      alert('Failed to load PDF file.');
    }
  }, [
    dispatch,
    flushLocalPendingQueue,
    hydrateRemoteDocument,
    restoreOfflinePendingState,
    serverUnreachable,
  ]);

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

  const handleExportCSV = () => {
    exportMeasurementsCSV(state.measurements, state.documentData?.name);
  };

  const handleExportJSON = () => {
    exportBackupJSON(state.annotations, state.measurements, state.scale, state.documentData?.name);
  };

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
        onExportCSV={handleExportCSV}
        onExportJSON={handleExportJSON}
      />

      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar />

        <main className="flex-1 flex flex-col relative bg-muted/40">
          {/* Server unreachable banner — persistent until connectivity is restored */}
          {showServerWarning && (
            <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-2 text-xs text-destructive font-medium text-center">
              ⚠ Changes won't be saved — server is unreachable. Check your connection or reload the page.
            </div>
          )}

          {/* Server-recovered retry banner */}
          {showRetryBanner && !showServerWarning && (
            <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-800 font-medium flex justify-between items-center">
              <span>
                {retrySuccess === true
                  ? '✓ Previously unsaved changes have been saved successfully.'
                  : retrySuccess === false
                  ? '✗ Some changes could not be saved. You may want to reload the page.'
                  : '⚠ Connection restored — some changes may not have saved while the server was down.'}
              </span>
              <div className="flex gap-2 ml-4 shrink-0">
                {retrySuccess === null && (
                  <button
                    onClick={handleRetry}
                    disabled={isRetrying}
                    className="underline hover:no-underline disabled:opacity-50"
                  >
                    {isRetrying ? 'Retrying…' : 'Retry saves'}
                  </button>
                )}
                <button
                  onClick={() => { setShowRetryBanner(false); setRetrySuccess(null); }}
                  className="opacity-70 hover:opacity-100 text-base leading-none"
                >
                  ×
                </button>
              </div>
            </div>
          )}

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
            <div id="pdf-scroll-container" className="flex-1 overflow-auto bg-muted p-8 print:p-0 print:bg-white print:overflow-visible">
              <div id="pdf-viewer-area" className="mx-auto w-max print:shadow-none print:border-none">
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
              {pendingCount > 0 && (
                <span className="text-amber-600 font-semibold">
                  ⏳ {pendingCount} unsaved change{pendingCount !== 1 ? 's' : ''} pending sync
                </span>
              )}
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
        <ScaleDialog
          onClose={() => setShowScaleDialog(false)}
          pixelDistance={pixelDistanceToScale}
          onScaleSaved={handleScaleSaved}
        />
      )}

      {/* Outage modal — shown when server drops while user is actively drawing */}
      <Dialog open={showOutageModal} onOpenChange={(open) => { if (!open) handleOutageModalClose(); }}>
        <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <span>⚠</span> Server unreachable
            </DialogTitle>
            <DialogDescription className="pt-2 space-y-2">
              <p>
                The connection to the server was lost while you were drawing. <strong>Any work you complete right now won't be saved</strong> until the server comes back.
              </p>
              <p>
                Your annotations are still visible on screen — they will remain safe as long as you don't reload the page.
              </p>
              <p className="text-foreground/80 font-medium">
                We recommend switching to Pan mode and waiting for connectivity to restore before continuing.
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowOutageModal(false)}>
              Continue drawing (unsaved risk)
            </Button>
            <Button variant="destructive" onClick={handleOutageModalClose}>
              Switch to Pan &amp; wait
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
