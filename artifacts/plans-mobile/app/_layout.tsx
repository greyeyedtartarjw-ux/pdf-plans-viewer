import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import { setBaseUrl } from '@workspace/api-client-react';
import { usePdfImport, isSharedPdfUrl, filenameFromUri } from '@/hooks/usePdfImport';
import { useColors } from '@/hooks/useColors';

// Set the API base URL once at module load — Expo bundles run outside the web
// proxy and need an absolute HTTPS URL to reach the shared API server.
const configuredApiDomain = process.env.EXPO_PUBLIC_DOMAIN;
if (!configuredApiDomain) {
  throw new Error(
    'EXPO_PUBLIC_DOMAIN is required. Release builds must target a configured API host.',
  );
}
const apiBaseUrl = configuredApiDomain.includes('://')
  ? configuredApiDomain
  : `https://${configuredApiDomain}`;
setBaseUrl(apiBaseUrl);

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000 },
  },
});

/**
 * Listens for PDF files shared to the app via the iOS Share Sheet
 * ("Open in Plans Mobile"). Must be rendered inside QueryClientProvider
 * so that usePdfImport can access the query client.
 */
function SharedFileListener() {
  const { importFromUri } = usePdfImport();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [importingFilename, setImportingFilename] = useState<string | null>(null);
  // Track URLs we've already handled to avoid double-processing on re-renders
  const handledUrls = useRef<Set<string>>(new Set());

  const handleUrl = async (url: string | null) => {
    if (!url) return;
    if (handledUrls.current.has(url)) return;
    if (!isSharedPdfUrl(url)) return;

    handledUrls.current.add(url);
    const name = filenameFromUri(url);
    setImportingFilename(name);
    let importError: unknown;
    try {
      await importFromUri(url, name);
    } catch (err) {
      importError = err;
    } finally {
      setImportingFilename(null);
    }

    if (importError) {
      Alert.alert(
        'Import Failed',
        importError instanceof Error
          ? importError.message
          : 'Could not open the shared PDF.',
      );
    }
  };

  useEffect(() => {
    // Handle the URL that launched the app (cold start via Share Sheet)
    Linking.getInitialURL().then((url) => handleUrl(url));

    // Handle URLs received while the app is already running
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleUrl(url);
    });

    return () => subscription.remove();
    // importFromUri is stable (useCallback), so this is safe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      transparent
      visible={importingFilename !== null}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <View
        style={styles.importOverlay}
        accessibilityViewIsModal
        accessibilityLabel={
          importingFilename ? `Importing ${importingFilename}` : undefined
        }
      >
        <View style={styles.importBackdrop} />
        <View style={styles.importCard}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.importTitle}>Importing PDF…</Text>
          <Text style={styles.importFilename} numberOfLines={2}>
            {importingFilename}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    importOverlay: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    importBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.sidebar,
      opacity: 0.72,
    },
    importCard: {
      width: '100%',
      maxWidth: 360,
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 24,
      paddingVertical: 28,
      borderRadius: colors.radius,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    importTitle: {
      color: colors.cardForeground,
      fontFamily: 'Inter_600SemiBold',
      fontSize: 18,
      textAlign: 'center',
    },
    importFilename: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 14,
      lineHeight: 20,
      textAlign: 'center',
    },
  });
}

function RootLayoutNav() {
  return (
    <>
      <SharedFileListener />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
