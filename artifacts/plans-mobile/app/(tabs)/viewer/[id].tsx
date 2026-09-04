import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createMeasurement,
  deleteMeasurement,
  listDocumentScales,
  listMeasurements,
  updateMeasurement,
} from '@workspace/api-client-react';
import { createViewerHtml } from '@/constants/viewerHtml';
import {
  pointsForMobileOverlay,
  toPdfArea,
  toPdfDistance,
} from '@/lib/pdfCoordinates';
import {
  recalculatedMeasurementValues,
  recalculatePixelMeasurements,
  type PixelMeasurement,
} from '@/lib/measurementRecalculation';
import type { LocalDocument } from '../index';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { PendingMeasurement } from '@/hooks/useOfflineQueue';
import { usePendingScale } from '@/hooks/usePendingScale';
import type { DocumentScaleInput } from '@/lib/pendingScale';
import {
  loadMeasurementsCache,
  removeCachedMeasurement,
  saveMeasurementsCache,
  upsertCachedMeasurement,
} from '@/lib/measurementsCache';

// --- Types ---
interface Point {
  x: number;
  y: number;
}

type MeasureMode = 'none' | 'distance' | 'area' | 'calibrate';
const SCALE_PRESETS = [
  { ratio: '1/8', pixelsPerUnit: 9 },
  { ratio: '1/4', pixelsPerUnit: 18 },
  { ratio: '3/6', pixelsPerUnit: 36 },
  { ratio: '3/4', pixelsPerUnit: 54 },
  { ratio: '1', pixelsPerUnit: 72 },
] as const;

interface WebViewMessage {
  type: string;
  mode?: MeasureMode;
  points?: Point[];
  x?: number;
  y?: number;
  count?: number;
  width?: number;
  height?: number;
  /** PDF page width in PDF natural units at scale=1 (stable across zoom / orientation). */
  naturalPageW?: number;
  page?: number;
  pages?: number;
  totalPages?: number;
  message?: string;
}

// A measurement as shown in the UI — may be confirmed (from API) or pending (offline).
interface DisplayMeasurement {
  id: string;
  documentId?: number;
  pageNumber: number;
  type: 'distance' | 'area';
  label: string;
  realWorldValue?: number;
  unit?: string;
  points: Record<string, unknown>[];
  fabricData?: Record<string, unknown>;
  createdAt?: string;
  /** true = saved locally but not yet confirmed by the API */
  isPending: boolean;
  /** stable local ID used to dequeue after API confirms */
  localId?: string;
}

// --- Helpers ---
const DOCS_STORAGE_KEY = '@plans_mobile_documents_v1';

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function totalDist(pts: Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].y - pts[i - 1].y) ** 2);
  }
  return d;
}

function shoelaceArea(pts: Point[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function formatValue(val: number, unit: string, isArea: boolean): string {
  const u = isArea ? `${unit}²` : unit;
  return `${val < 10 ? val.toFixed(2) : val.toFixed(1)} ${u}`;
}

const pdfJsLibraryAsset = require('../../../assets/pdfjs/pdf.min.txt');
const pdfJsWorkerAsset = require('../../../assets/pdfjs/pdf.worker.min.txt');

// --- Main Screen ---
export default function ViewerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = parseInt(id ?? '0', 10);
  const queryClient = useQueryClient();

  // Offline queue
  const { pendingForDoc, isSyncing, isOnline, enqueue, dequeue, flush } =
    useOfflineQueue();

  // WebView stored in state so React re-renders when the dynamic import resolves
  const webViewRef = useRef<any>(null);
  const [WebViewComponent, setWebViewComponent] = useState<any>(null);
  const pdfBase64Ref = useRef<string | null>(null);

  // State
  const [doc, setDoc] = useState<LocalDocument | null>(null);
  const [mode, setMode] = useState<MeasureMode>('none');
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [showPanel, setShowPanel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recalculationProgress, setRecalculationProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);

  // Calibration state
  const [calibModal, setCalibModal] = useState(false);
  const [scaleChooserModal, setScaleChooserModal] = useState(false);
  const [calibPixelDist, setCalibPixelDist] = useState(0);
  const [calibValue, setCalibValue] = useState('');
  const [calibSaving, setCalibSaving] = useState(false);

  // Keep mutable refs for use inside message handler (avoids stale closures)
  const modeRef = useRef<MeasureMode>('none');
  const pageRef = useRef(1);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  // The PDF page width at PDF.js scale=1. Unlike the WebView canvas width,
  // this is stable when the phone rotates or the viewer is resized.
  const naturalPageWidthRef = useRef(0);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);

  // Load document record from AsyncStorage
  useEffect(() => {
    AsyncStorage.getItem(DOCS_STORAGE_KEY).then((data) => {
      if (!data) return;
      const docs: LocalDocument[] = JSON.parse(data);
      const found = docs.find((d) => d.id === docId) ?? null;
      setDoc(found);
    });
  }, [docId]);

  // On native: dynamically import WebView to avoid SSR crash on web.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    import('react-native-webview').then((m) => {
      setWebViewComponent(() => m.WebView);
    });
  }, []);

  // Read PDF from filesystem and send to WebView
  useEffect(() => {
    if (!doc) return;
    FileSystem.readAsStringAsync(doc.localPath, {
      encoding: FileSystem.EncodingType.Base64,
    })
      .then((base64) => {
        pdfBase64Ref.current = base64;
        if (webViewRef.current) {
          sendMsg({ type: 'loadPdf', base64 });
        }
      })
      .catch(() => {
        Alert.alert('Error', 'Could not read PDF file. It may have been deleted.');
      });
  }, [doc]);

  // Load the device cache alongside the API so existing drawings render
  // immediately on a slow connection and after an offline restart.
  const { data: cachedMeasurements = [] } = useQuery({
    queryKey: ['measurements-cache', docId],
    queryFn: () => loadMeasurementsCache(docId),
    enabled: !!docId,
  });

  const { data: apiMeasurements, refetch: refetchMeasurements } = useQuery({
    queryKey: ['measurements', docId],
    queryFn: async () => {
      const requestStartedAt = Date.now();
      try {
        const data = await listMeasurements(docId);
        const reconciled = await saveMeasurementsCache(
          docId,
          data,
          requestStartedAt,
        );
        queryClient.setQueryData(['measurements-cache', docId], reconciled);
        return reconciled;
      } catch {
        return loadMeasurementsCache(docId);
      }
    },
    enabled: !!docId,
  });

  const { data: remoteScales = [] } = useQuery({
    queryKey: ['scales', docId],
    queryFn: () => listDocumentScales(docId),
    enabled: !!docId,
  });

  // Merge API measurements with offline-pending ones for display.
  // Pending items are shown first so users immediately see what they drew.
  const pendingItems = pendingForDoc(docId);
  const confirmedMeasurements = apiMeasurements ?? cachedMeasurements;

  const measurements: DisplayMeasurement[] = [
    // Pending (locally stored, not yet confirmed by server)
    ...pendingItems
      .filter((p) => p.operation !== 'update')
      .map((p): DisplayMeasurement => ({
      id: p.localId,
      pageNumber: p.input.pageNumber,
      type: p.input.type,
      label: p.input.label,
      realWorldValue: p.input.realWorldValue,
      unit: p.input.unit,
      points: p.input.points,
      fabricData: p.input.fabricData,
      createdAt: p.createdAt,
      isPending: true,
      localId: p.localId,
      })),
    // Confirmed (API)
    ...confirmedMeasurements.map((m): DisplayMeasurement => ({
      ...m,
      points: m.points as Record<string, unknown>[],
      fabricData: m.fabricData as Record<string, unknown>,
      isPending: false,
    })),
  ];

  // API mutations
  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createMeasurement>[1]) =>
      createMeasurement(docId, input),
    onSuccess: async (created) => {
      const cached = await upsertCachedMeasurement(docId, created);
      queryClient.setQueryData(['measurements-cache', docId], cached);
      queryClient.setQueryData(
        ['measurements', docId],
        (current: typeof apiMeasurements | undefined) => [
          ...((current ?? []).filter((measurement) => measurement.id !== created.id)),
          created,
        ],
      );
      queryClient.invalidateQueries({ queryKey: ['measurements', docId] });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (mId: string) => deleteMeasurement(docId, mId),
    onSuccess: async (_data, mId) => {
      const cached = await removeCachedMeasurement(docId, mId);
      queryClient.setQueryData(['measurements-cache', docId], cached);
      queryClient.setQueryData(
        ['measurements', docId],
        (current: typeof apiMeasurements | undefined) =>
          current?.filter((measurement) => measurement.id !== mId),
      );
      queryClient.invalidateQueries({ queryKey: ['measurements', docId] });
    },
  });

  const handleScaleSynced = useCallback((_pageNumber: number, _input: DocumentScaleInput) => {
    void queryClient.invalidateQueries({ queryKey: ['scales', docId] });
  }, [docId, queryClient]);
  const { pendingScale, savePendingScale } = usePendingScale(docId, page, handleScaleSynced);
  // A locally queued calibration wins over the last server value so new
  // measurements stay accurate after an offline restart.
  const scale = pendingScale?.input ?? remoteScales.find((item) => item.pageNumber === page);

  const updateMeasurementMutation = useMutation({
    mutationFn: ({
      measurementId,
      input,
    }: {
      measurementId: string;
      input: Parameters<typeof updateMeasurement>[2];
    }) => updateMeasurement(docId, measurementId, input),
    onSuccess: async (updated) => {
      const cached = await upsertCachedMeasurement(docId, updated);
      queryClient.setQueryData(['measurements-cache', docId], cached);
      queryClient.setQueryData(
        ['measurements', docId],
        (current: typeof apiMeasurements | undefined) =>
          current
            ? current.map((measurement) =>
                measurement.id === updated.id ? updated : measurement,
              )
            : cached,
      );
    },
  });

  // Push saved measurements to WebView whenever they change
  useEffect(() => {
    if (!webViewRef.current) return;
    const pageMeasurements = measurements
      .filter((m) => m.pageNumber === page)
      .map((m) => {
        return {
          id: m.id,
          type: m.type,
          // Points are persisted in the source mobile canvas's coordinate
          // system. Rescale the overlay to the active viewport without
          // changing the stable PDF-unit value used for calculations.
          points: pointsForMobileOverlay(
            m.points as unknown as Point[],
            m.fabricData as Record<string, unknown>,
            canvasSize.width,
          ),
          label: m.label,
        };
      });
    sendMsg({ type: 'setSavedMeasurements', measurements: pageMeasurements });
  }, [measurements, page, canvasSize]);

  // When the queue finishes syncing, refresh API data so the list is up to date
  useEffect(() => {
    if (!isSyncing) {
      queryClient.invalidateQueries({ queryKey: ['measurements', docId] });
    }
  }, [isSyncing, docId, queryClient]);

  // --- WebView communication ---
  function sendMsg(data: object) {
    if (!webViewRef.current) return;
    const js = `(function(){var e=new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(data))}}); window.dispatchEvent(e);})(); true;`;
    webViewRef.current.injectJavaScript(js);
  }

  const handleWebViewMsg = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let msg: WebViewMessage;
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ready':
          if (pdfBase64Ref.current) {
            sendMsg({ type: 'loadPdf', base64: pdfBase64Ref.current });
          }
          break;

        case 'pdfLoaded':
          setTotalPages(msg.pages ?? 1);
          break;

        case 'pageRendered':
          setLoadingPdf(false);
          if (msg.width && msg.height) {
            const size = { width: msg.width, height: msg.height };
            setCanvasSize(size);
            canvasSizeRef.current = size;
          }
          if (msg.naturalPageW) {
            naturalPageWidthRef.current = msg.naturalPageW;
          }
          break;

        case 'pointAdded':
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setCurrentPoints((prev) => [...prev, { x: msg.x ?? 0, y: msg.y ?? 0 }]);
          if (msg.width && msg.height) {
            const size = { width: msg.width, height: msg.height };
            setCanvasSize(size);
            canvasSizeRef.current = size;
          }
          break;

        case 'measurementComplete':
          if (modeRef.current === 'calibrate') {
            // Don't save — open the calibration input modal instead
            const pts = msg.points ?? [];
            const viewportDistance = pts.length >= 2 ? totalDist(pts) : 0;
            const viewportWidth = msg.width ?? canvasSizeRef.current.width;
            const naturalWidth = msg.naturalPageW ?? naturalPageWidthRef.current;
            // Store calibration in PDF page units, exactly as the web viewer
            // does after dividing its Fabric coordinates by the zoom factor.
            const pageDistance = toPdfDistance(viewportDistance, viewportWidth, naturalWidth);
            setCalibPixelDist(pageDistance);
            setCalibValue('');
            setCalibModal(true);
            // Reset WebView & mode state
            setMode('none');
            modeRef.current = 'none';
            setCurrentPoints([]);
          } else {
            finalizeMeasurement(
              msg.mode ?? modeRef.current,
              msg.points ?? [],
              msg.width ?? canvasSizeRef.current.width,
              msg.height ?? canvasSizeRef.current.height,
              msg.naturalPageW ?? naturalPageWidthRef.current,
            );
          }
          break;

        case 'error':
          setLoadingPdf(false);
          Alert.alert('PDF Error', msg.message ?? 'Unknown error');
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scale],
  );

  async function finalizeMeasurement(
    mMode: string,
    points: Point[],
    cw: number,
    ch: number,
    naturalPageWidth: number,
  ) {
    if (points.length < 2) return;
    if (!scale?.isSet || !scale.pixelsPerUnit || scale.pixelsPerUnit <= 0) {
      Alert.alert('Scale required', `Set a scale for page ${pageRef.current} before measuring.`);
      clearCalibrationOverlay();
      return;
    }
    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const isArea = mMode === 'area';
    const viewportValue = isArea ? shoelaceArea(points) : totalDist(points);
    // Measurements are taken on a canvas sized to the device width. Convert
    // them to PDF page units before applying the document-wide scale so a
    // rotation or a measurement in the web viewer produces the same value.
    const pixelValue = isArea
      ? toPdfArea(viewportValue, cw, naturalPageWidth)
      : toPdfDistance(viewportValue, cw, naturalPageWidth);

    const linearPPU = scale.pixelsPerUnit;
    // For area, scale factor is squared
    const realWorldValue = isArea
      ? pixelValue / (linearPPU * linearPPU)
      : pixelValue / linearPPU;
    const unit = isArea ? 'ft²' : 'ft';
    const label = formatValue(realWorldValue, 'ft', isArea);

    const measurementId = genId();
    const localId = `local_${measurementId}`;

    const input = {
      id: measurementId,
      pageNumber: pageRef.current,
      type: isArea ? ('area' as const) : ('distance' as const),
      label,
      valueLabel: label,
      realWorldValue,
      unit,
      points: points as unknown as Record<string, unknown>[],
      fabricData: {
        canvasWidth: cw,
        canvasHeight: ch,
        platform: 'mobile',
      } as Record<string, unknown>,
    };

    // ── Step 1: persist locally immediately so it's visible even if offline ──
    const pendingItem: PendingMeasurement = {
      localId,
      docId,
      input,
      createdAt: new Date().toISOString(),
    };
    await enqueue(pendingItem);

    // ── Step 2: try to save to the API ───────────────────────────────────────
    try {
      await createMutation.mutateAsync(input);
      // Success — remove from the offline queue (API now owns it)
      await dequeue(localId);
      await refetchMeasurements();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      // Network unavailable — item stays in queue; synced automatically when online
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      // No error alert; the pending indicator in the UI tells the story
    } finally {
      setSaving(false);
      // Reset tool
      setMode('none');
      modeRef.current = 'none';
      setCurrentPoints([]);
      sendMsg({ type: 'setMode', mode: 'none' });
      sendMsg({ type: 'clearCurrentPoints' });
    }
  }

  async function applyPixelMeasurementRecalculation(
    pixelMeasurements: PixelMeasurement[],
    savedPixelsPerUnit: number,
    savedRealWorldUnit: string,
  ) {
    setRecalculationProgress({ completed: 0, total: pixelMeasurements.length });
    const failedMeasurements = await recalculatePixelMeasurements(
      pixelMeasurements,
      savedPixelsPerUnit,
      savedRealWorldUnit,
      {
        updatePending: async (measurement, values) => {
          const pending = pendingItems.find((item) => item.localId === measurement.id);
          if (!pending) throw new Error('Pending measurement is no longer available');
          await enqueue({
            ...pending,
            input: {
              ...pending.input,
              ...values,
            },
          });
        },
        updateConfirmed: (measurement, values) =>
          updateMeasurementMutation.mutateAsync({
            measurementId: measurement.id,
            input: values,
          }),
        onProgress: (completed, total) =>
          setRecalculationProgress({ completed, total }),
      },
    );
    setRecalculationProgress(null);

    for (const failed of failedMeasurements) {
      if (failed.isPending) continue;
      const source = confirmedMeasurements.find((measurement) => measurement.id === failed.id);
      if (!source) continue;
      const values = recalculatedMeasurementValues(
        failed,
        savedPixelsPerUnit,
        savedRealWorldUnit,
      );
      const pendingUpdate: PendingMeasurement = {
        localId: `measurement-update:${source.id}`,
        docId,
        operation: 'update',
        input: {
          id: source.id,
          pageNumber: source.pageNumber,
          type: source.type,
          label: values.label,
          valueLabel: values.valueLabel,
          realWorldValue: values.realWorldValue,
          unit: values.unit,
          points: source.points as Record<string, unknown>[],
          fabricData: source.fabricData as Record<string, unknown>,
        },
        createdAt: new Date().toISOString(),
      };
      await enqueue(pendingUpdate);
      const cached = await upsertCachedMeasurement(docId, {
        ...source,
        ...values,
      });
      queryClient.setQueryData(['measurements-cache', docId], cached);
      queryClient.setQueryData(
        ['measurements', docId],
        (current: typeof apiMeasurements | undefined) =>
          current?.map((measurement) =>
            measurement.id === source.id ? { ...measurement, ...values } : measurement,
          ),
      );
    }

    if (pixelMeasurements.some((measurement) => !measurement.isPending)) {
      await queryClient.invalidateQueries({ queryKey: ['measurements', docId] });
    }

    if (failedMeasurements.length > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Some measurements were not updated',
        `${failedMeasurements.length} measurement${failedMeasurements.length === 1 ? '' : 's'} could not be recalculated.`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Retry',
            onPress: () => {
              void applyPixelMeasurementRecalculation(
                failedMeasurements,
                savedPixelsPerUnit,
                savedRealWorldUnit,
              );
            },
          },
        ],
      );
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function startPixelMeasurementRecalculation(
    savedPixelsPerUnit: number,
    savedRealWorldUnit: string,
  ) {
    const pixelMeasurements: PixelMeasurement[] = measurements
      .filter(
        (measurement) =>
          measurement.pageNumber === page
          && (measurement.unit === 'px' || measurement.unit === 'px²'),
      )
      .map((measurement) => ({
        id: measurement.id,
        type: measurement.type,
        label: measurement.label,
        valueLabel: 'valueLabel' in measurement && typeof measurement.valueLabel === 'string'
          ? measurement.valueLabel
          : measurement.label,
        realWorldValue: measurement.realWorldValue,
        isPending: measurement.isPending,
      }));

    if (pixelMeasurements.length === 0) {
      Alert.alert(
        'Scale saved',
        `1 ${savedRealWorldUnit} = ${savedPixelsPerUnit.toFixed(2)} plan units. New measurements will now show real-world distances.`,
      );
      return;
    }

    void applyPixelMeasurementRecalculation(
      pixelMeasurements,
      savedPixelsPerUnit,
      savedRealWorldUnit,
    );
  }

  // --- Calibration save ---
  async function saveScaleInput(input: DocumentScaleInput) {
    setCalibSaving(true);
    try {
      await savePendingScale(input);
      closeCalibrationModal();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Scale saved locally',
        `Page ${page} is ready to measure in feet. This scale will sync automatically when the connection returns.`,
      );
      const hasPixelMeasurements = measurements.some(
        (measurement) =>
          measurement.pageNumber === page
          && (measurement.unit === 'px' || measurement.unit === 'px²'),
      );
      if (hasPixelMeasurements) {
        startPixelMeasurementRecalculation(input.pixelsPerUnit, 'ft');
      }
    } catch {
      Alert.alert('Save failed', 'Could not save the scale locally. Please try again.');
    } finally {
      setCalibSaving(false);
    }
  }

  async function saveScale() {
    const num = parseFloat(calibValue);
    if (!num || num <= 0 || calibPixelDist <= 0) {
      Alert.alert('Invalid value', 'Please enter a positive distance in feet.');
      return;
    }
    const pixelsPerUnit = calibPixelDist / num;
    await saveScaleInput({
        pixelsPerUnit,
        unit: 'px',
        realWorldUnit: 'ft',
        isSet: true,
        scaleKind: 'custom',
        presetRatio: null,
        calibrationDistanceFeet: num,
    });
  }

  function clearCalibrationOverlay() {
    sendMsg({ type: 'setMode', mode: 'none' });
    sendMsg({ type: 'clearCurrentPoints' });
  }

  function closeCalibrationModal() {
    setCalibModal(false);
    clearCalibrationOverlay();
  }

  // --- Tool actions ---
  function selectMode(next: MeasureMode) {
    if ((next === 'distance' || next === 'area') && !scale?.isSet) {
      Alert.alert('Scale required', `Set a scale for page ${page} before measuring.`);
      return;
    }
    // 'calibrate' is not a toggle — always activate it fresh
    const newMode = next === 'calibrate' ? 'calibrate' : mode === next ? 'none' : next;
    setMode(newMode);
    modeRef.current = newMode;
    setCurrentPoints([]);
    // Calibration has its own WebView mode, with the same two-point flow as distance.
    sendMsg({ type: 'setMode', mode: newMode });
    sendMsg({ type: 'clearCurrentPoints' });
    if (newMode !== 'none') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function choosePreset(ratio: typeof SCALE_PRESETS[number]['ratio'], pixelsPerUnit: number) {
    setScaleChooserModal(false);
    void saveScaleInput({
      isSet: true,
      pixelsPerUnit,
      unit: 'px',
      realWorldUnit: 'ft',
      scaleKind: 'preset',
      presetRatio: ratio,
      calibrationDistanceFeet: null,
    });
  }

  function beginCustomCalibration() {
    setScaleChooserModal(false);
    selectMode('calibrate');
  }

  function undoLastPoint() {
    if (currentPoints.length === 0) return;
    setCurrentPoints((prev) => prev.slice(0, -1));
    sendMsg({ type: 'undoPoint' });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function finishArea() {
    if (mode === 'area' && currentPoints.length >= 3) {
      sendMsg({ type: 'finishArea' });
    }
  }

  function goToPage(delta: number) {
    const next = page + delta;
    if (next < 1 || next > totalPages) return;
    setPage(next);
    pageRef.current = next;
    setCurrentPoints([]);
    setLoadingPdf(true);
    sendMsg({ type: 'setPage', page: next });
    sendMsg({ type: 'setMode', mode: modeRef.current });
  }

  function confirmDelete(mId: string, label: string, isPending: boolean, localId?: string) {
    Alert.alert('Delete Measurement', `Delete "${label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (isPending && localId) {
            // Remove from offline queue only
            await dequeue(localId);
          } else {
            deleteMutation.mutate(mId);
          }
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        },
      },
    ]);
  }

  // --- Layout ---
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;
  const styles = makeStyles(colors);
  const pageMeasurements = measurements.filter((m) => m.pageNumber === page);
  const pendingCount = pendingItems.length;
  const pendingCountForPage = pendingItems.filter(
    (measurement) => measurement.input.pageNumber === page,
  ).length;

  const WV = WebViewComponent;
  const localViewerHtml = createViewerHtml(
    Image.resolveAssetSource(pdfJsLibraryAsset).uri,
    Image.resolveAssetSource(pdfJsWorkerAsset).uri,
  );

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.headerBtn}
          testID="back-button"
        >
          <Ionicons name="arrow-back" size={22} color={colors.foreground} />
        </TouchableOpacity>

        <Text style={styles.headerTitle} numberOfLines={1}>
          {doc?.name ?? 'Loading…'}
        </Text>

        {!isOnline && (
          <View
            style={styles.offlineChip}
            accessibilityRole="text"
            accessibilityLabel="Device is offline"
            testID="offline-status-chip"
          >
            <Ionicons
              name="cloud-offline-outline"
              size={13}
              color={colors.destructiveForeground}
            />
            <Text style={styles.offlineChipText}>Offline</Text>
          </View>
        )}

        {/* Page navigation */}
        <View style={styles.pageNav}>
          <TouchableOpacity
            onPress={() => goToPage(-1)}
            disabled={page <= 1}
            style={styles.pageBtn}
          >
            <Ionicons
              name="chevron-back"
              size={17}
              color={page <= 1 ? colors.mutedForeground : colors.foreground}
            />
          </TouchableOpacity>
          <Text style={styles.pageText}>
            {page}/{totalPages}
          </Text>
          <TouchableOpacity
            onPress={() => goToPage(1)}
            disabled={page >= totalPages}
            style={styles.pageBtn}
          >
            <Ionicons
              name="chevron-forward"
              size={17}
              color={page >= totalPages ? colors.mutedForeground : colors.foreground}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Pending-sync banner — shown when there are unsynced measurements */}
      {pendingCount > 0 && (
        <TouchableOpacity
          style={[styles.pendingBanner, { backgroundColor: colors.primary }]}
          onPress={() => flush(pendingItems)}
          activeOpacity={0.8}
          testID="pending-sync-banner"
        >
          {isSyncing ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Ionicons name="cloud-upload-outline" size={14} color={colors.primaryForeground} />
          )}
          <Text style={[styles.pendingBannerText, { color: colors.primaryForeground }]}>
            {isSyncing
              ? 'Syncing measurements…'
              : `${pendingCount} measurement${pendingCount !== 1 ? 's' : ''} pending sync — tap to retry`}
          </Text>
        </TouchableOpacity>
      )}

      {recalculationProgress && (
        <View
          style={[
            styles.recalculationBanner,
            { backgroundColor: colors.muted, borderBottomColor: colors.border },
          ]}
        >
          <ActivityIndicator size="small" color={colors.foreground} />
          <Text style={[styles.recalculationBannerText, { color: colors.foreground }]}>
            Recalculating measurements… {recalculationProgress.completed}/
            {recalculationProgress.total}
          </Text>
        </View>
      )}

      {/* PDF WebView */}
      <View style={styles.pdfWrap}>
        {Platform.OS !== 'web' && WV ? (
          <WV
            ref={webViewRef}
            source={{ html: localViewerHtml }}
            style={styles.webView}
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['*']}
            onMessage={handleWebViewMsg}
            scrollEnabled={mode === 'none'}
            bounces={false}
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            mixedContentMode="always"
          />
        ) : (
          <View style={styles.webFallback}>
            <MaterialCommunityIcons
              name="cellphone-arrow-down"
              size={44}
              color={colors.mutedForeground}
            />
            <Text style={styles.webFallbackText}>
              Open on a mobile device to view and measure PDF plans
            </Text>
          </View>
        )}

        {/* Loading overlay */}
        {loadingPdf && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>Loading PDF…</Text>
          </View>
        )}

        {/* Saving badge */}
        {saving && (
          <View style={styles.savingBadge}>
            <ActivityIndicator size="small" color={colors.primaryForeground} />
            <Text style={styles.savingText}>Saving…</Text>
          </View>
        )}

        {/* Instruction overlay */}
        {mode !== 'none' && !saving && (
          <View style={styles.instruction}>
            <Text style={styles.instructionText}>
              {mode === 'calibrate' && currentPoints.length === 0 && 'Tap the start of a known distance'}
              {mode === 'calibrate' && currentPoints.length === 1 && 'Tap the end of the known distance'}
              {mode === 'distance' && currentPoints.length === 0 && 'Tap to place start point'}
              {mode === 'distance' && currentPoints.length === 1 && 'Tap to place end point'}
              {mode === 'area' && currentPoints.length === 0 && 'Tap to place first point'}
              {mode === 'area' &&
                currentPoints.length >= 1 &&
                currentPoints.length < 3 &&
                `${currentPoints.length} point${currentPoints.length !== 1 ? 's' : ''} — keep tapping`}
              {mode === 'area' &&
                currentPoints.length >= 3 &&
                'Tap first point to close · or press ✓'}
            </Text>
          </View>
        )}
      </View>

      {/* Scale status bar */}
      <TouchableOpacity
        style={[
          styles.scaleBar,
          { backgroundColor: scale?.isSet ? colors.card : colors.primary },
        ]}
        onPress={() => setScaleChooserModal(true)}
        activeOpacity={0.8}
      >
        <Ionicons
          name={scale?.isSet ? 'checkmark-circle-outline' : 'warning-outline'}
          size={13}
          color={scale?.isSet ? colors.primary : colors.primaryForeground}
        />
        <Text
          style={[
            styles.scaleBarText,
            { color: scale?.isSet ? colors.foreground : colors.primaryForeground, flex: 1 },
          ]}
        >
          {scale?.isSet
            ? scale.scaleKind === 'preset'
              ? `Page ${page}: ${scale.presetRatio}" = 1'  · Tap to change`
              : `Page ${page}: custom ${scale.calibrationDistanceFeet} ft  · Tap to change`
            : `Page ${page}: scale not set  · Tap to choose`}
        </Text>
      </TouchableOpacity>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        {/* Measurement tools */}
        <ToolButton
          icon={
            <MaterialCommunityIcons
              name="ruler"
              size={20}
              color={mode === 'distance' ? colors.primaryForeground : colors.foreground}
            />
          }
          label="Distance"
          active={mode === 'distance'}
          activeColor={colors.primary}
          onPress={() => selectMode('distance')}
          colors={colors}
        />
        <ToolButton
          icon={
            <MaterialCommunityIcons
              name="vector-polygon"
              size={20}
              color={mode === 'area' ? colors.primaryForeground : colors.foreground}
            />
          }
          label="Area"
          active={mode === 'area'}
          activeColor={colors.primary}
          onPress={() => selectMode('area')}
          colors={colors}
        />
        <ToolButton
          icon={
            <MaterialCommunityIcons
              name="target"
              size={20}
              color={mode === 'calibrate' ? colors.primaryForeground : colors.foreground}
            />
          }
          label="Set Scale"
          active={mode === 'calibrate'}
          activeColor="#F59E0B"
          onPress={() => setScaleChooserModal(true)}
          colors={colors}
        />

        <View style={styles.spacer} />

        {/* Context actions */}
        {mode !== 'none' && (
          <TouchableOpacity
            style={[styles.iconBtn, currentPoints.length === 0 && { opacity: 0.35 }]}
            onPress={undoLastPoint}
            disabled={currentPoints.length === 0}
            testID="undo-button"
          >
            <Ionicons name="arrow-undo" size={20} color={colors.foreground} />
          </TouchableOpacity>
        )}

        {mode === 'area' && currentPoints.length >= 3 && (
          <TouchableOpacity
            style={[styles.iconBtn, { backgroundColor: colors.primary, borderRadius: colors.radius }]}
            onPress={finishArea}
            testID="finish-area-button"
          >
            <Ionicons name="checkmark" size={20} color={colors.primaryForeground} />
          </TouchableOpacity>
        )}

        {/* Measurements panel toggle */}
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => setShowPanel((v) => !v)}
          testID="measurements-toggle"
        >
          <View>
            <Ionicons
              name="list"
              size={20}
              color={showPanel ? colors.primary : colors.foreground}
            />
            {pageMeasurements.length > 0 && (
              <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                <Text style={[styles.badgeText, { color: colors.primaryForeground }]}>
                  {pageMeasurements.length}
                </Text>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>

      {/* Measurements panel */}
      {showPanel && (
        <View style={[styles.panel, { paddingBottom: Math.max(bottomPad, 8) }]}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>
              Measurements — Page {page}
            </Text>
            {pendingCountForPage > 0 && (
              <View style={[styles.pendingPill, { backgroundColor: colors.primary }]}>
                <Text style={[styles.pendingPillText, { color: colors.primaryForeground }]}>
                  {pendingCountForPage} pending
                </Text>
              </View>
            )}
          </View>
          <ScrollView
            style={{ maxHeight: 200 }}
            keyboardShouldPersistTaps="handled"
          >
            {pageMeasurements.length === 0 ? (
              <Text style={styles.panelEmpty}>
                No measurements on this page yet. Select a tool above and tap the plan to start.
              </Text>
            ) : (
              pageMeasurements.map((m) => (
                <View key={m.id} style={[styles.measureRow, m.isPending && styles.measureRowPending]}>
                  <MaterialCommunityIcons
                    name={m.type === 'distance' ? 'ruler' : 'vector-polygon'}
                    size={15}
                    color={m.isPending ? colors.mutedForeground : colors.primary}
                  />
                  <Text
                    style={[styles.measureLabel, m.isPending && { color: colors.mutedForeground }]}
                    numberOfLines={1}
                  >
                    {m.label}
                  </Text>
                  {m.isPending && (
                    <View style={styles.pendingDot}>
                      <Ionicons name="cloud-upload-outline" size={13} color={colors.mutedForeground} />
                    </View>
                  )}
                  <TouchableOpacity
                    onPress={() => confirmDelete(m.id, m.label, m.isPending, m.localId)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons
                      name="trash-outline"
                      size={15}
                      color={colors.mutedForeground}
                    />
                  </TouchableOpacity>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      )}

      {/* Calibration modal */}
      <Modal
        visible={scaleChooserModal}
        transparent
        animationType="slide"
        onRequestClose={() => setScaleChooserModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: Math.max(bottomPad, 24) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Set scale for page {page}</Text>
              <TouchableOpacity onPress={() => setScaleChooserModal(false)}>
                <Ionicons name="close" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSubtitle}>Choose the plan ratio. Measurements are always saved in feet.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SCALE_PRESETS.map((preset) => (
                <TouchableOpacity
                  key={preset.ratio}
                  style={[styles.unitBtn, { borderColor: colors.border, backgroundColor: colors.card, minWidth: '30%' }]}
                  onPress={() => choosePreset(preset.ratio, preset.pixelsPerUnit)}
                >
                  <Text style={[styles.unitBtnText, { color: colors.foreground }]}>{preset.ratio}" = 1'</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: colors.primary, marginTop: 16 }]}
              onPress={beginCustomCalibration}
            >
              <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>Custom two-point calibration</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={calibModal}
        transparent
        animationType="slide"
        onRequestClose={closeCalibrationModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.modalSheet, { paddingBottom: Math.max(bottomPad, 24) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Set Scale</Text>
              <TouchableOpacity onPress={closeCalibrationModal} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              You tapped{' '}
              <Text style={{ fontFamily: 'Inter_600SemiBold', color: colors.foreground }}>
                {calibPixelDist.toFixed(1)} plan units
              </Text>
              . Enter the real-world length that distance represents.
            </Text>

            {/* Real-world value input */}
            <Text style={styles.inputLabel}>Distance (feet)</Text>
            <TextInput
              style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]}
              keyboardType="decimal-pad"
              placeholder="e.g. 3.5"
              placeholderTextColor={colors.mutedForeground}
              value={calibValue}
              onChangeText={setCalibValue}
              autoFocus
            />

            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: calibSaving ? 0.6 : 1 }]}
              onPress={saveScale}
              disabled={calibSaving}
            >
              {calibSaving ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>Save Scale</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// --- ToolButton component ---
function ToolButton({
  icon,
  label,
  active,
  activeColor,
  onPress,
  colors,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  activeColor: string;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <TouchableOpacity
      style={[
        {
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: colors.radius,
          gap: 3,
          minWidth: 68,
        },
        active && { backgroundColor: activeColor },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {icon}
      <Text
        style={{
          fontSize: 10,
          fontFamily: 'Inter_500Medium',
          color: active ? colors.primaryForeground : colors.mutedForeground,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// --- Styles ---
function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 6,
    },
    headerBtn: {
      padding: 6,
    },
    headerTitle: {
      flex: 1,
      fontSize: 15,
      fontWeight: '600' as const,
      color: colors.foreground,
      fontFamily: 'Inter_600SemiBold',
    },
    offlineChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: colors.radius,
      backgroundColor: colors.destructive,
    },
    offlineChipText: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: colors.destructiveForeground,
      fontFamily: 'Inter_600SemiBold',
    },
    pageNav: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    pageBtn: {
      padding: 6,
    },
    pageText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      minWidth: 36,
      textAlign: 'center',
    },
    pendingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    pendingBannerText: {
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      flex: 1,
    },
    recalculationBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    recalculationBannerText: {
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
    },
    pdfWrap: {
      flex: 1,
      backgroundColor: '#1D2530',
      position: 'relative',
    },
    webView: {
      flex: 1,
      backgroundColor: '#1D2530',
    },
    webFallback: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      paddingHorizontal: 40,
    },
    webFallbackText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
      lineHeight: 21,
    },
    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: '#1D2530',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
    },
    loadingText: {
      fontSize: 14,
      color: colors.primary,
      fontFamily: 'Inter_400Regular',
    },
    savingBadge: {
      position: 'absolute',
      top: 12,
      right: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      backgroundColor: colors.primary,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 20,
    },
    savingText: {
      fontSize: 13,
      fontFamily: 'Inter_600SemiBold',
      color: colors.primaryForeground,
    },
    instruction: {
      position: 'absolute',
      bottom: 14,
      alignSelf: 'center',
      backgroundColor: 'rgba(29,37,48,0.88)',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
    },
    instructionText: {
      fontSize: 13,
      color: '#FFFFFF',
      fontFamily: 'Inter_500Medium',
    },
    scaleBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    scaleBarText: {
      fontSize: 11,
      fontFamily: 'Inter_500Medium',
    },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    spacer: {
      flex: 1,
    },
    iconBtn: {
      padding: 10,
    },
    badge: {
      position: 'absolute',
      top: -3,
      right: -3,
      width: 15,
      height: 15,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: {
      fontSize: 9,
      fontWeight: '700' as const,
    },
    panel: {
      backgroundColor: colors.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    panelHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      gap: 8,
    },
    panelTitle: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: colors.foreground,
      fontFamily: 'Inter_600SemiBold',
      flex: 1,
    },
    pendingPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 10,
    },
    pendingPillText: {
      fontSize: 10,
      fontFamily: 'Inter_600SemiBold',
    },
    panelEmpty: {
      paddingHorizontal: 16,
      paddingBottom: 16,
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      lineHeight: 20,
    },
    measureRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    measureRowPending: {
      opacity: 0.7,
    },
    measureLabel: {
      flex: 1,
      fontSize: 14,
      color: colors.foreground,
      fontFamily: 'Inter_400Regular',
    },
    // Calibration modal
    modalOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    modalSheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 20,
      gap: 0,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    modalTitle: {
      fontSize: 17,
      fontFamily: 'Inter_600SemiBold',
      color: colors.foreground,
    },
    modalSubtitle: {
      fontSize: 13,
      fontFamily: 'Inter_400Regular',
      color: colors.mutedForeground,
      lineHeight: 19,
      marginBottom: 18,
    },
    inputLabel: {
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      color: colors.mutedForeground,
      marginBottom: 6,
    },
    textInput: {
      borderWidth: 1,
      borderRadius: colors.radius,
      paddingHorizontal: 14,
      paddingVertical: 11,
      fontSize: 16,
      fontFamily: 'Inter_400Regular',
      marginBottom: 16,
    },
    unitRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 24,
    },
    unitBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: colors.radius,
      borderWidth: 1,
    },
    unitBtnText: {
      fontSize: 13,
      fontFamily: 'Inter_500Medium',
    },
    saveBtn: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      borderRadius: colors.radius,
    },
    saveBtnText: {
      fontSize: 15,
      fontFamily: 'Inter_600SemiBold',
    },
    pendingDot: {
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
