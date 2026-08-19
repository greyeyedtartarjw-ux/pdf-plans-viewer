import React, { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
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

// Set the API base URL once at module load — Expo bundles run outside the web
// proxy and need absolute URLs to reach the shared API server.
setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);

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
  // Track URLs we've already handled to avoid double-processing on re-renders
  const handledUrls = useRef<Set<string>>(new Set());

  const handleUrl = async (url: string | null) => {
    if (!url) return;
    if (handledUrls.current.has(url)) return;
    if (!isSharedPdfUrl(url)) return;

    handledUrls.current.add(url);
    const name = filenameFromUri(url);
    try {
      await importFromUri(url, name);
    } catch (err) {
      Alert.alert(
        'Import Failed',
        (err as Error).message ?? 'Could not open the shared PDF.',
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

  return null;
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
