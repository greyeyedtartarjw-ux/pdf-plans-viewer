import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
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
  getDocumentScale,
  listMeasurements,
} from '@workspace/api-client-react';
import { viewerHtml } from '@/constants/viewerHtml';
import type { LocalDocument } from '../index';

// --- Types ---
interface Point {
  x: number;
  y: number;
}

type MeasureMode = 'none' | 'distance' | 'area';

interface WebViewMessage {
  type: string;
  mode?: MeasureMode;
  points?: Point[];
  x?: number;
  y?: number;
  count?: number;
  width?: number;
  height?: number;
  page?: number;
  pages?: number;
  totalPages?: number;
  message?: string;
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

// --- Main Screen ---
export default function ViewerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = parseInt(id ?? '0', 10);
  const queryClient = useQueryClient();

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

  // Keep mutable refs for use inside message handler (avoids stale closures)
  const modeRef = useRef<MeasureMode>('none');
  const pageRef = useRef(1);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

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
  // Storing in state (not a ref) so React re-renders once the class is ready.
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

  // API queries
  const { data: measurements = [], refetch: refetchMeasurements } = useQuery({
    queryKey: ['measurements', docId],
    queryFn: () => listMeasurements(docId),
    enabled: !!docId,
  });

  const { data: scale } = useQuery({
    queryKey: ['scale', docId],
    queryFn: () => getDocumentScale(docId),
    enabled: !!docId,
  });

  // API mutations
  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createMeasurement>[1]) =>
      createMeasurement(docId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['measurements', docId] });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (mId: string) => deleteMeasurement(docId, mId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['measurements', docId] });
    },
  });

  // Push saved measurements to WebView whenever they change
  useEffect(() => {
    if (!webViewRef.current) return;
    const pageMeasurements = measurements
      .filter((m) => m.pageNumber === page)
      .map((m) => ({
        id: m.id,
        type: m.type,
        points: m.points as unknown as Point[],
        label: m.label,
      }));
    sendMsg({ type: 'setSavedMeasurements', measurements: pageMeasurements });
  }, [measurements, page]);

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
          // WebView is ready — send PDF if we already have it
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
          finalizeMeasurement(
            msg.mode ?? modeRef.current,
            msg.points ?? [],
            msg.width ?? canvasSizeRef.current.width,
            msg.height ?? canvasSizeRef.current.height,
          );
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
  ) {
    if (points.length < 2) return;
    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const isArea = mMode === 'area';
    const pixelValue = isArea ? shoelaceArea(points) : totalDist(points);

    // Scale calibrated on the web app uses web-canvas pixel coordinates which
    // differ from mobile viewport-scaled pixels. To avoid silently saving wrong
    // real-world values, mobile measurements always store pixel values until
    // mobile-side calibration is implemented (see follow-up task).
    const realWorldValue = pixelValue;
    const unit = isArea ? 'px²' : 'px';

    const label = formatValue(realWorldValue, isArea ? 'px' : 'px', isArea);

    try {
      await createMutation.mutateAsync({
        id: genId(),
        pageNumber: pageRef.current,
        type: isArea ? 'area' : 'distance',
        label,
        realWorldValue,
        unit,
        points: points as unknown as Record<string, unknown>[],
        fabricData: {
          canvasWidth: cw,
          canvasHeight: ch,
          platform: 'mobile',
        } as unknown as Record<string, unknown>,
      });
      await refetchMeasurements();
    } catch {
      Alert.alert('Save Failed', 'Could not save the measurement. Please try again.');
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

  // --- Tool actions ---
  function selectMode(next: MeasureMode) {
    const newMode = mode === next ? 'none' : next;
    setMode(newMode);
    modeRef.current = newMode;
    setCurrentPoints([]);
    sendMsg({ type: 'setMode', mode: newMode });
    sendMsg({ type: 'clearCurrentPoints' });
    if (newMode !== 'none') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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

  function confirmDelete(mId: string, label: string) {
    Alert.alert('Delete Measurement', `Delete "${label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMutation.mutate(mId);
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

  const WV = WebViewComponent;

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

      {/* PDF WebView */}
      <View style={styles.pdfWrap}>
        {Platform.OS !== 'web' && WV ? (
          <WV
            ref={webViewRef}
            source={{ html: viewerHtml }}
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

      {/* Scale warning if no scale set */}
      {scale && !scale.isSet && (
        <View style={[styles.scaleBar, { backgroundColor: colors.primary }]}>
          <Ionicons name="warning-outline" size={13} color={colors.primaryForeground} />
          <Text style={[styles.scaleBarText, { color: colors.primaryForeground }]}>
            No scale set — results shown in pixels. Set scale in the web app.
          </Text>
        </View>
      )}

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
                <View key={m.id} style={styles.measureRow}>
                  <MaterialCommunityIcons
                    name={m.type === 'distance' ? 'ruler' : 'vector-polygon'}
                    size={15}
                    color={colors.primary}
                  />
                  <Text style={styles.measureLabel} numberOfLines={1}>
                    {m.label}
                  </Text>
                  <TouchableOpacity
                    onPress={() => confirmDelete(m.id, m.label)}
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
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
    },
    panelTitle: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: colors.foreground,
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
    measureLabel: {
      flex: 1,
      fontSize: 14,
      color: colors.foreground,
      fontFamily: 'Inter_400Regular',
    },
  });
}
