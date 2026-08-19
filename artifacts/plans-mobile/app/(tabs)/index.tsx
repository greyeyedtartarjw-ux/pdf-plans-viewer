import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { usePdfImport } from '@/hooks/usePdfImport';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listMeasurements } from '@workspace/api-client-react';
import {
  loadMeasurementsCache,
  saveMeasurementsCache,
} from '@/lib/measurementsCache';

const DOCS_STORAGE_KEY = '@plans_mobile_documents_v1';

export interface LocalDocument {
  id: number;
  name: string;
  localPath: string;
  hash: string;
  addedAt: string;
}

export async function loadLocalDocuments(): Promise<LocalDocument[]> {
  const data = await AsyncStorage.getItem(DOCS_STORAGE_KEY);
  return data ? (JSON.parse(data) as LocalDocument[]) : [];
}

export async function saveLocalDocuments(docs: LocalDocument[]): Promise<void> {
  await AsyncStorage.setItem(DOCS_STORAGE_KEY, JSON.stringify(docs));
}

export default function DocumentsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { importFromUri } = usePdfImport();
  const [refreshing, setRefreshing] = useState(false);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  const { data: localDocs = [], refetch } = useQuery({
    queryKey: ['localDocuments'],
    queryFn: loadLocalDocuments,
  });

  // + button: open the system document picker then hand off to the shared import logic
  const addDocMutation = useMutation({
    mutationFn: async () => {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return null;

      const asset = result.assets[0];
      return importFromUri(asset.uri, asset.name, asset.size ?? 0);
    },
    onError: (error) => {
      Alert.alert('Import Failed', (error as Error).message);
    },
  });

  const deleteDoc = useCallback(
    (doc: LocalDocument) => {
      Alert.alert(
        'Remove Plan',
        `Remove "${doc.name}" from this device? Measurements saved to the server will be preserved.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              const existing = await loadLocalDocuments();
              await saveLocalDocuments(existing.filter((d) => d.id !== doc.id));
              try {
                await FileSystem.deleteAsync(doc.localPath, {
                  idempotent: true,
                });
              } catch {}
              queryClient.invalidateQueries({ queryKey: ['localDocuments'] });
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            },
          },
        ],
      );
    },
    [queryClient],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const styles = makeStyles(colors);

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>FIELD PLANS</Text>
          <Text style={styles.headerTitle}>Documents</Text>
        </View>
        <TouchableOpacity
          style={[
            styles.addBtn,
            addDocMutation.isPending && styles.addBtnDisabled,
          ]}
          onPress={() => addDocMutation.mutate()}
          disabled={addDocMutation.isPending}
          activeOpacity={0.75}
          testID="add-document-button"
        >
          {addDocMutation.isPending ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Ionicons name="add" size={24} color={colors.primaryForeground} />
          )}
        </TouchableOpacity>
      </View>

      {/* List */}
      <FlatList
        data={localDocs}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: bottomPad + 20 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <MaterialCommunityIcons
                name="file-document-outline"
                size={40}
                color={colors.mutedForeground}
              />
            </View>
            <Text style={styles.emptyTitle}>No plans imported</Text>
            <Text style={styles.emptySub}>
              Tap the + button to import a PDF plan and start measuring
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <DocumentCard
            doc={item}
            colors={colors}
            onPress={() => router.push(`/viewer/${item.id}`)}
            onLongPress={() => deleteDoc(item)}
          />
        )}
      />
    </View>
  );
}

function DocumentCard({
  doc,
  colors,
  onPress,
  onLongPress,
}: {
  doc: LocalDocument;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const styles = makeStyles(colors);
  const queryClient = useQueryClient();

  // Load the local cache independently so the count is available immediately,
  // rather than waiting for a slow or unavailable API request.
  const { data: cachedMeasurements = [] } = useQuery({
    queryKey: ['measurements-cache', doc.id],
    queryFn: () => loadMeasurementsCache(doc.id),
  });

  const { data: remoteMeasurements } = useQuery({
    queryKey: ['measurements', doc.id],
    queryFn: async () => {
      const requestStartedAt = Date.now();
      try {
        const measurements = await listMeasurements(doc.id);
        const reconciled = await saveMeasurementsCache(
          doc.id,
          measurements,
          requestStartedAt,
        );
        queryClient.setQueryData(['measurements-cache', doc.id], reconciled);
        return reconciled;
      } catch {
        return loadMeasurementsCache(doc.id);
      }
    },
    staleTime: 30_000,
  });
  const measurements = remoteMeasurements ?? cachedMeasurements;

  const date = new Date(doc.addedAt);
  const dateStr = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.72 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={`document-card-${doc.id}`}
    >
      <View style={styles.cardIconWrap}>
        <MaterialCommunityIcons
          name="file-document-outline"
          size={26}
          color={colors.primary}
        />
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardName} numberOfLines={1}>
          {doc.name}
        </Text>
        <Text style={styles.cardMeta}>
          {measurements.length === 0
            ? 'No measurements'
            : `${measurements.length} measurement${measurements.length !== 1 ? 's' : ''}`}{' '}
          · {dateStr}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerLabel: {
      fontSize: 10,
      fontWeight: '700' as const,
      letterSpacing: 1.5,
      color: colors.primary,
      fontFamily: 'Inter_700Bold',
      marginBottom: 2,
    },
    headerTitle: {
      fontSize: 26,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      letterSpacing: -0.5,
    },
    addBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnDisabled: {
      opacity: 0.7,
    },
    listContent: {
      padding: 16,
      gap: 10,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      padding: 16,
      gap: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    cardIconWrap: {
      width: 46,
      height: 46,
      borderRadius: colors.radius,
      backgroundColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardBody: {
      flex: 1,
    },
    cardName: {
      fontSize: 15,
      fontWeight: '600' as const,
      color: colors.foreground,
      fontFamily: 'Inter_600SemiBold',
      marginBottom: 3,
    },
    cardMeta: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
    },
    emptyState: {
      alignItems: 'center',
      paddingTop: 80,
      paddingHorizontal: 32,
      gap: 12,
    },
    emptyIconWrap: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 4,
    },
    emptyTitle: {
      fontSize: 17,
      fontWeight: '600' as const,
      color: colors.foreground,
      fontFamily: 'Inter_600SemiBold',
    },
    emptySub: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
      lineHeight: 21,
    },
  });
}
