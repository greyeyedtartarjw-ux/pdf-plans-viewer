import React, { useRef, useState, useEffect, useCallback, useReducer } from 'react';
import { flushSync } from 'react-dom';
import { useViewerContext } from '../store/ViewerContext';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import EmptyState from './EmptyState';
import { getDocumentContentHash, getLegacyDocumentKey } from '../lib/documentIdentity';
import {
  BackupValidationError,
  exportMeasurementsCSV,
  exportBackupJSON,
  parseBackupJSON,
} from '../lib/exportUtils';
import { mergePendingState } from '../lib/pendingState';
import { createBackupRestoreOps } from '../lib/backupRestore';
import {
  upsertDocument,
  listAnnotations,
  listMeasurements,
  listDocumentScales,
  setDocumentPageScale,
  getShare,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  createMeasurement,
  deleteMeasurement,
  updateMeasurement,
  useHealthCheck,
  getHealthCheckQueryKey,
} from '@workspace/api-client-react';
import { DEFAULT_SCALE, type Scale, type Annotation, type Measurement } from '../types';
import {
  recalculatePixelMeasurement,
  updateFabricMeasurementLabel,
} from '../lib/measurementUtils';
import {
  addPendingOp,
  clearPendingOps,
  getCachedDocumentId,
  getPendingOps,
  countPendingOps,
  flushPendingOps,
  nextPendingSequence,
  pendingMeasurementValueLabel,
  QUEUE_CHANGED_EVENT,
  removeCachedDocumentId,
  setCachedDocumentId,
  restorePendingOps,
  type PendingOp,
} from '../lib/pendingQueue';
import { bytesToPdfFile, desktopApi, type DesktopSnapshot } from '../lib/desktopBridge';
import {
  desktopRecoveryReducer,
  initialDesktopRecoveryState,
} from '../lib/desktopRecoveryState';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';

const PDFPageViewer = React.lazy(() => import('./PDFPageViewer'));
const ScaleDialog = React.lazy(() => import('./ScaleDialog'));

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
      valueLabel: m.valueLabel,
      realWorldValue: m.realWorldValue,
      unit: m.unit,
      points: m.points as { x: number; y: number }[],
      data: m.fabricData,
    });
  }
  return result;
}

// Map API ScaleConfig → local Scale shape
function mapApiScale(apiScale: Awaited<ReturnType<typeof listDocumentScales>>[number]): Scale {
  return {
    set: apiScale.isSet,
    pixelsPerUnit: apiScale.pixelsPerUnit,
    unit: 'px',
    realWorldUnit: 'ft',
    scaleKind: apiScale.scaleKind,
    presetRatio: apiScale.presetRatio,
    calibrationDistanceFeet: apiScale.calibrationDistanceFeet,
  };
}

/** Tools that are passive (viewing/navigating). Active drawing tools are everything else. */
const PASSIVE_TOOLS = new Set(['pan', 'select']);

function mapApiScales(apiScales: Awaited<ReturnType<typeof listDocumentScales>>): Record<number, Scale> {
  return Object.fromEntries(apiScales.map((scale) => [scale.pageNumber, mapApiScale(scale)]));
}

export default function Shell() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, documentId, activeTool } = state;
  const scale = state.scales[state.currentPage] ?? DEFAULT_SCALE;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const registeringDocumentRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  const [showScaleDialog, setShowScaleDialog] = useState(false);
  const [pixelDistanceToScale, setPixelDistanceToScale] = useState<number | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [isRegisteringOfflinePlan, setIsRegisteringOfflinePlan] = useState(false);
  const [desktopRecovery, updateDesktopRecovery] = useReducer(
    desktopRecoveryReducer,
    initialDesktopRecoveryState,
  );
  const desktopRecoveryId = desktopRecovery.committedRecoveryId;

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
        } else if (op.opType === 'update_annotation') {
          await updateAnnotation(op.documentId, op.id, {
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
            valueLabel: pendingMeasurementValueLabel(op),
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
            valueLabel: pendingMeasurementValueLabel(op),
            realWorldValue: op.realWorldValue,
            unit: op.unit,
            fabricData: op.fabricData,
          });
        } else if (op.opType === 'set_scale') {
          await setDocumentPageScale(op.documentId, op.pageNumber, {
            isSet: op.isSet,
            pixelsPerUnit: op.pixelsPerUnit,
            unit: op.unit,
            realWorldUnit: op.realWorldUnit,
            scaleKind: op.scaleKind,
            presetRatio: op.presetRatio,
            calibrationDistanceFeet: op.calibrationDistanceFeet,
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
    const pageNumber = state.currentPage;
    dispatch({ type: 'SET_PAGE_SCALE', page: pageNumber, scale: savedScale });
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'pan' });
    if (documentId) {
      // Queue first so a lost request cannot discard a calibration. The flush
      // replays scale before later recalculated measurement updates.
      addPendingOp({
        opType: 'set_scale',
        documentId,
          id: `scale:${pageNumber}`,
          pageNumber,
        isSet: savedScale.set,
        pixelsPerUnit: savedScale.pixelsPerUnit,
        unit: savedScale.unit,
        realWorldUnit: savedScale.realWorldUnit,
          scaleKind: savedScale.scaleKind,
          presetRatio: savedScale.presetRatio,
          calibrationDistanceFeet: savedScale.calibrationDistanceFeet,
        timestamp: Date.now(),
        sequence: nextPendingSequence(),
      });
      setPendingCount(countPendingOps(documentId));
      void flushLocalPendingQueue(documentId).catch((error) => {
        console.error('Could not save scale', error);
      });
    }

    const pixelMeasurements = (state.measurements[pageNumber] ?? [])
      .filter((measurement) => measurement.unit === 'px' || measurement.unit === 'px²')
      .map((measurement) => ({ page: pageNumber, measurement }));

    for (const { page, measurement } of pixelMeasurements) {
      const values = recalculatePixelMeasurement(measurement, savedScale);
      const label = measurement.label === measurement.valueLabel ? values.label : measurement.label;
      const valueLabel = values.label;
      const fabricData = updateFabricMeasurementLabel(measurement.data, label);
      dispatch({
        type: 'UPDATE_MEASUREMENT_VALUES',
        page,
        id: measurement.id,
        valueLabel,
        realWorldValue: values.realWorldValue,
        unit: values.unit,
        data: fabricData,
      });

      if (!documentId) continue;

      const queueUpdate = () => {
        addPendingOp({
          opType: 'update_measurement',
          documentId,
          id: measurement.id,
          pageNumber: page,
          label,
          valueLabel,
          realWorldValue: values.realWorldValue,
          unit: values.unit,
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
        label,
        valueLabel,
        realWorldValue: values.realWorldValue,
        unit: values.unit,
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
    state.currentPage,
    state.measurements,
  ]);

  /** Restore queued local work without requiring the API to be reachable. */
  const restoreOfflinePendingState = useCallback((docId: number) => {
    const pendingOps = getPendingOps(docId);
    const merged = mergePendingState({}, {}, pendingOps, {});
    dispatch({
      type: 'LOAD_REMOTE_STATE',
      documentId: docId,
      annotations: merged.annotations,
      measurements: merged.measurements,
       scales: merged.scales,
    });
    setPendingCount(pendingOps.length);
    needsRemoteHydrationRef.current = true;
    return pendingOps.length;
  }, [dispatch]);

  /** Refresh remote state after an offline reopen, preserving queued local work. */
  const hydrateRemoteDocument = useCallback(async (
    docId: number,
    isCurrent: () => boolean = () => true,
  ) => {
    const [apiAnnotations, apiMeasurements, apiScales] = await Promise.all([
      listAnnotations(docId),
      listMeasurements(docId),
      listDocumentScales(docId),
    ]);
    const pendingOps = getPendingOps(docId);
    if (!isCurrent()) return pendingOps.length;
    const remoteScales = mapApiScales(apiScales);
    const merged = mergePendingState(
      mapApiAnnotations(apiAnnotations),
      mapApiMeasurements(apiMeasurements),
      pendingOps,
      remoteScales,
    );
    dispatch({
      type: 'LOAD_REMOTE_STATE',
      documentId: docId,
      annotations: merged.annotations,
      measurements: merged.measurements,
       scales: merged.scales,
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

    const loadGeneration = loadGenerationRef.current;
    const isCurrent = () => loadGeneration === loadGenerationRef.current;
    dispatch({ type: 'SET_SYNCING', syncing: true });
    getShare(token)
      .then((payload) => {
        if (!isCurrent()) return;
        dispatch({
          type: 'LOAD_REMOTE_STATE',
          documentId: payload.document.id,
          annotations: mapApiAnnotations(payload.annotations),
          measurements: mapApiMeasurements(payload.measurements),
          scales: mapApiScales(payload.scales),
          shareToken: token,
        });
        setShareMsg(`Shared view loaded for "${payload.document.name}". Open that PDF file to see the drawing.`);
      })
      .catch(() => {
        if (!isCurrent()) return;
        dispatch({ type: 'SET_SYNCING', syncing: false });
        setShareMsg('Share link is invalid or has expired.');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load a PDF file ───────────────────────────────────────────────────────
  const handleFileSelect = useCallback(async (file: File, stagedRecoveryId?: string) => {
    const loadGeneration = ++loadGenerationRef.current;
    const isCurrent = () => loadGeneration === loadGenerationRef.current;
    let resolvedDocumentId: number | null = null;
    let recoveryId = stagedRecoveryId;
    registeringDocumentRef.current = true;
    setIsRegisteringOfflinePlan(true);
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'pan' });
    try {
      const desktop = desktopApi();
      if (desktop) {
        recoveryId = recoveryId
          ?? await desktop.stagePdf(new Uint8Array(await file.arrayBuffer()));
        if (!isCurrent()) return;
        updateDesktopRecovery({ type: 'stage', recoveryId });
      }
      // PDF.js is only needed after the user chooses a plan. Keeping it out of
      // the initial route makes the empty viewer responsive on slow connections.
      const { loadPDF } = await import('../lib/pdfUtils');
      const doc = await loadPDF(file);
      if (!isCurrent()) return;
      const hash = await getDocumentContentHash(file);
      if (!isCurrent()) return;
      // Name-and-size mappings from older releases can collide across
      // different PDFs, so they are intentionally discarded rather than
      // migrated to the content digest.
      removeCachedDocumentId(getLegacyDocumentKey(file));
      resolvedDocumentId = getCachedDocumentId(hash);

      flushSync(() => {
        dispatch({
          type: 'SET_PDF_DOC',
          doc,
          data: { name: file.name, size: file.size, hash },
          totalPages: doc.numPages,
        });
        if (recoveryId) {
          updateDesktopRecovery({ type: 'commit', recoveryId });
        }
      });

      // Register (or re-find) the document on the server, then cache that ID
      // against this local PDF hash for a future offline reopen.
      const serverDoc = await upsertDocument({ name: file.name, hash });
      if (!isCurrent()) return;
      resolvedDocumentId = serverDoc.id;
      setCachedDocumentId(hash, serverDoc.id);
      const queued = await hydrateRemoteDocument(serverDoc.id, isCurrent);
      if (!isCurrent()) return;

      // If the server is reachable right now, flush the queue immediately
      // (covers the case where the user reloads after a connectivity gap that
      // has since resolved).
      if (queued > 0 && !serverUnreachable) {
        flushLocalPendingQueue(serverDoc.id);
      }

      setShareMsg(null);
    } catch (err) {
      if (!isCurrent()) return;
      if (recoveryId) {
        updateDesktopRecovery({ type: 'abandon', recoveryId });
      }
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
    } finally {
      if (isCurrent()) {
        registeringDocumentRef.current = false;
        setIsRegisteringOfflinePlan(false);
      }
    }
  }, [
    dispatch,
    flushLocalPendingQueue,
    hydrateRemoteDocument,
    restoreOfflinePendingState,
    serverUnreachable,
  ]);

  const handleOpenClick = useCallback(async () => {
    const desktop = desktopApi();
    if (!desktop) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const selected = await desktop.openPdf();
      if (selected) {
        await handleFileSelect(
          bytesToPdfFile(selected.name, selected.bytes),
          selected.recoveryId,
        );
      }
    } catch (error) {
      console.error('Could not open PDF', error);
      alert(error instanceof Error ? error.message : 'Could not open the selected PDF.');
    }
  }, [handleFileSelect]);

  // Recover the last desktop plan before the user has to select it again.
  useEffect(() => {
    const desktop = desktopApi();
    if (!desktop || new URLSearchParams(window.location.search).has('share')) return;
    const loadGeneration = ++loadGenerationRef.current;
    const isCurrent = () => loadGeneration === loadGenerationRef.current;
    let cancelled = false;
    void desktop.loadState().then(async (recovered) => {
      if (!recovered || cancelled || !isCurrent()) return;
      const snapshot = recovered.state;
      updateDesktopRecovery({ type: 'commit', recoveryId: snapshot.recoveryId });
      const file = bytesToPdfFile(snapshot.name, recovered.bytes);
      const { loadPDF } = await import('../lib/pdfUtils');
      const doc = await loadPDF(file);
      if (cancelled || !isCurrent()) return;
      dispatch({
        type: 'SET_PDF_DOC',
        doc,
        data: { name: snapshot.name, size: snapshot.size, hash: snapshot.hash },
        totalPages: doc.numPages,
      });
      if (snapshot.documentId) {
        restorePendingOps(snapshot.documentId, snapshot.pendingOps);
        dispatch({
          type: 'LOAD_REMOTE_STATE',
          documentId: snapshot.documentId,
          annotations: snapshot.annotations,
          measurements: snapshot.measurements,
          scales: snapshot.scales,
        });
        setPendingCount(snapshot.pendingOps.length);
        needsRemoteHydrationRef.current = true;
      } else {
        dispatch({
          type: 'LOAD_LOCAL_STATE',
          annotations: snapshot.annotations,
          measurements: snapshot.measurements,
          scales: snapshot.scales,
        });
      }
      setShareMsg('Recovered your last desktop plan and locally saved work.');
    }).catch((error) => {
      console.error('Could not recover the last desktop plan', error);
    });
    return () => {
      cancelled = true;
      if (isCurrent()) loadGenerationRef.current++;
    };
  }, [dispatch]);

  // A plan first opened while offline has no server ID yet. Once the API is
  // reachable, register it and turn its complete local snapshot into ordered
  // create operations before hydrating and flushing.
  useEffect(() => {
    const documentData = state.documentData;
    if (
      !serverReachable
      || !state.pdfDoc
      || !documentData
      || documentId
      || registeringDocumentRef.current
    ) return;

    registeringDocumentRef.current = true;
    setIsRegisteringOfflinePlan(true);
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'pan' });
    const registerAndSync = async () => {
      try {
        const serverDoc = await upsertDocument({
          name: documentData.name,
          hash: documentData.hash,
        });
        setCachedDocumentId(documentData.hash, serverDoc.id);
        const latestState = latestStateRef.current;

        for (const annotation of Object.values(latestState.annotations).flat()) {
          addPendingOp({
            opType: 'create_annotation',
            documentId: serverDoc.id,
            id: annotation.id,
            pageNumber: annotation.pageNumber,
            type: annotation.type,
            fabricData: annotation.data,
            timestamp: Date.now(),
            sequence: nextPendingSequence(),
          });
        }
        for (const measurement of Object.values(latestState.measurements).flat()) {
          addPendingOp({
            opType: 'create_measurement',
            documentId: serverDoc.id,
            id: measurement.id,
            pageNumber: measurement.pageNumber,
            type: measurement.type,
            label: measurement.label,
            valueLabel: measurement.valueLabel,
            realWorldValue: measurement.realWorldValue,
            unit: measurement.unit,
            points: measurement.points,
            fabricData: measurement.data,
            timestamp: Date.now(),
            sequence: nextPendingSequence(),
          });
        }
        for (const [page, savedScale] of Object.entries(latestState.scales)) {
          addPendingOp({
            opType: 'set_scale',
            documentId: serverDoc.id,
            id: `scale:${page}`,
            pageNumber: Number(page),
            isSet: savedScale.set,
            pixelsPerUnit: savedScale.pixelsPerUnit,
            unit: savedScale.unit,
            realWorldUnit: savedScale.realWorldUnit,
            scaleKind: savedScale.scaleKind,
            presetRatio: savedScale.presetRatio,
            calibrationDistanceFeet: savedScale.calibrationDistanceFeet,
            timestamp: Date.now(),
            sequence: nextPendingSequence(),
          });
        }

        await hydrateRemoteDocument(serverDoc.id);
        await flushLocalPendingQueue(serverDoc.id);
      } catch (error) {
        console.error('Could not register the offline desktop plan', error);
        setShareMsg('Your work remains saved locally and will sync when the server is reachable.');
      } finally {
        registeringDocumentRef.current = false;
        setIsRegisteringOfflinePlan(false);
      }
    };
    void registerAndSync();
  }, [
    documentId,
    flushLocalPendingQueue,
    hydrateRemoteDocument,
    serverReachable,
    state.annotations,
    state.documentData,
    state.measurements,
    state.pdfDoc,
    state.scales,
  ]);

  // Electron writes snapshots atomically under the OS application-data folder.
  // Browser builds continue to use their existing localStorage queue.
  useEffect(() => {
    const desktop = desktopApi();
    const documentData = state.documentData;
    if (!desktop || !desktopRecoveryId || !documentData || !state.pdfDoc) return;
    const timer = window.setTimeout(() => {
      const snapshot: DesktopSnapshot = {
        version: 2,
        recoveryId: desktopRecoveryId,
        savedAt: Date.now(),
        name: documentData.name,
        hash: documentData.hash,
        size: documentData.size,
        documentId,
        annotations: state.annotations,
        measurements: state.measurements,
        scales: state.scales,
        pendingOps: documentId ? getPendingOps(documentId) : [],
      };
      void desktop.saveState(snapshot).catch((error) => {
        console.error('Could not save desktop recovery state', error);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    documentId,
    desktopRecoveryId,
    pendingCount,
    state.annotations,
    state.documentData,
    state.measurements,
    state.pdfDoc,
    state.scales,
  ]);

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const handleSnapshot = async () => {
    const viewerElement = document.getElementById('pdf-viewer-area');
    if (!viewerElement) return;
    try {
      // Snapshotting is optional and html2canvas is comparatively expensive,
      // so it should not delay opening or viewing a plan.
      const { default: html2canvas } = await import('html2canvas');
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

  const handleSetScale = () => {
    setPixelDistanceToScale(null);
    setShowScaleDialog(true);
  };

  const handleExportCSV = () => {
    exportMeasurementsCSV(state.measurements, state.documentData?.name);
  };

  const handleExportJSON = () => {
    exportBackupJSON(state.annotations, state.measurements, state.scales, state.documentData?.name);
  };

  const handleImportJSON = useCallback(async (file: File) => {
    if (!state.pdfDoc || !state.documentData || !state.documentId) {
      alert('Wait for the matching PDF to finish opening before importing its backup.');
      return;
    }
    const expectedDocument = state.documentData;
    const loadGeneration = ++loadGenerationRef.current;
    try {
      const backup = parseBackupJSON(await file.text(), expectedDocument.name, state.totalPages);
      if (
        loadGeneration !== loadGenerationRef.current
        || latestStateRef.current.documentData?.hash !== expectedDocument.hash
      ) {
        throw new BackupValidationError('The open PDF changed before the backup finished loading. Please import it again.');
      }
      const restoreOps = createBackupRestoreOps(
        state.documentId,
        {
          annotations: state.annotations,
          measurements: state.measurements,
          scales: state.scales,
        },
        backup,
        nextPendingSequence,
      );
      // Persist the complete restore intent before changing visible state so
      // offline imports survive reload and replay in causal order.
      clearPendingOps(state.documentId);
      for (const operation of restoreOps) addPendingOp(operation);
      dispatch({
        type: 'IMPORT_BACKUP_STATE',
        annotations: backup.annotations,
        measurements: backup.measurements,
        scales: backup.scales,
      });
      needsRemoteHydrationRef.current = false;
      setPendingCount(restoreOps.length);
      if (!serverUnreachable) {
        void flushLocalPendingQueue(state.documentId).catch((error) => {
          console.error('Could not sync restored backup', error);
        });
      }
      setShareMsg(`Backup restored from ${new Date(backup.exportedAt).toLocaleString()}.`);
    } catch (error) {
      alert(error instanceof BackupValidationError ? error.message : 'The backup could not be read.');
    }
  }, [
    dispatch,
    flushLocalPendingQueue,
    serverUnreachable,
    state.annotations,
    state.documentData,
    state.documentId,
    state.measurements,
    state.pdfDoc,
    state.scales,
    state.totalPages,
  ]);

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
    <div className="relative flex flex-col h-screen w-full bg-background overflow-hidden font-sans">
      {isRegisteringOfflinePlan && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-[1px]">
          <div className="rounded-md border bg-background px-5 py-3 text-sm font-medium shadow-lg">
            Connecting this offline plan… Your local work is safe.
          </div>
        </div>
      )}
      <input
        type="file"
        accept="application/pdf"
        ref={fileInputRef}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) handleFileSelect(e.target.files[0]);
        }}
      />
      <input
        type="file"
        accept="application/json,.json"
        ref={backupInputRef}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleImportJSON(file);
        }}
      />

      <Toolbar
        onOpenClick={handleOpenClick}
        onSnapshot={handleSnapshot}
        onPrint={handlePrint}
        onSetScale={handleSetScale}
        onExportCSV={handleExportCSV}
        onExportJSON={handleExportJSON}
        onImportJSON={() => backupInputRef.current?.click()}
      />

      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar />

        <main className="flex-1 min-w-0 flex flex-col relative bg-muted/40">
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
               <div id="pdf-viewer-area" className="mx-auto min-h-full w-max min-w-full print:shadow-none print:border-none">
                <React.Suspense
                  fallback={(
                    <div className="flex min-h-[50vh] min-w-[50vw] items-center justify-center text-muted-foreground text-sm">
                      Loading plan viewer…
                    </div>
                  )}
                >
                  <PDFPageViewer />
                </React.Suspense>
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
              <span>
                Page scale: {scale.set
                  ? scale.scaleKind === 'preset'
                    ? `${scale.presetRatio}" = 1'`
                    : `Custom (${scale.calibrationDistanceFeet} ft)`
                  : 'Not set — choose a scale before measuring'}
              </span>
              <span>Zoom: {Math.round(state.zoom * 100)}%</span>
            </div>
          </footer>
        </main>
      </div>

      {showScaleDialog && (
        <React.Suspense fallback={null}>
          <ScaleDialog
            onClose={() => setShowScaleDialog(false)}
            pixelDistance={pixelDistanceToScale}
            pageNumber={state.currentPage}
            onScaleSaved={handleScaleSaved}
            onStartCustomCalibration={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'set-scale' })}
          />
        </React.Suspense>
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
