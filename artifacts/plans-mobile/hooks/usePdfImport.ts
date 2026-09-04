import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { upsertDocument } from '@workspace/api-client-react';
import {
  loadLocalDocuments,
  saveLocalDocuments,
  type LocalDocument,
} from '@/app/(tabs)/index';

/**
 * Returns an `importFromUri` function that copies a PDF from any URI
 * (file:// from Share Sheet, or asset URI from DocumentPicker) into the
 * app's persistent storage, registers it with the API, and navigates to
 * the viewer. Can be used both from the + button and from the Linking
 * handler that catches "Open in Plans Mobile" from iOS Share Sheet.
 */
export function usePdfImport() {
  const queryClient = useQueryClient();

  const importFromUri = useCallback(
    async (uri: string, name: string, size?: number) => {
      const sourceUri = sharedPdfUri(uri);
      if (!sourceUri) {
        throw new Error('The shared link is not a supported PDF URL.');
      }

      const isRemote = sourceUri.toLowerCase().startsWith('https://');
      let storedSourceUri = sourceUri;

      if (isRemote) {
        const downloadPath =
          FileSystem.documentDirectory +
          `shared_pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
        const download = await FileSystem.downloadAsync(sourceUri, downloadPath);
        if (download.status < 200 || download.status >= 300) {
          await FileSystem.deleteAsync(downloadPath, { idempotent: true });
          throw new Error(`Could not download the PDF (HTTP ${download.status}).`);
        }
        storedSourceUri = download.uri;
      }

      // Resolve file size when not provided (e.g. shared or downloaded URLs).
      let fileSize = size;
      if (fileSize == null) {
        try {
          const info = await FileSystem.getInfoAsync(storedSourceUri);
          fileSize = info.exists && 'size' in info ? (info.size ?? 0) : 0;
        } catch {
          fileSize = 0;
        }
      }

      // Fingerprint must match the web app's convention: `${name}-${size}`
      const hash = `${name}-${fileSize}`;
      const safeFilename = name.replace(/[^a-zA-Z0-9]/g, '_');
      const destPath =
        FileSystem.documentDirectory +
        safeFilename.slice(0, 40) +
        `_${fileSize}.pdf`;

      if (storedSourceUri !== destPath) {
        if (isRemote) {
          await FileSystem.moveAsync({ from: storedSourceUri, to: destPath });
        } else {
          await FileSystem.copyAsync({ from: storedSourceUri, to: destPath });
        }
      }

      const doc = await upsertDocument({ name, hash });

      const existing = await loadLocalDocuments();
      const newDoc: LocalDocument = {
        id: doc.id,
        name: doc.name,
        localPath: destPath,
        hash: doc.hash,
        addedAt: new Date().toISOString(),
      };
      await saveLocalDocuments([newDoc, ...existing.filter((d) => d.hash !== hash)]);

      queryClient.invalidateQueries({ queryKey: ['localDocuments'] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(`/viewer/${doc.id}`);

      return newDoc;
    },
    [queryClient],
  );

  return { importFromUri };
}

/**
 * Extracts a usable filename from a file:// URI delivered by the iOS Share Sheet.
 * Falls back to a timestamped generic name when the URI carries no basename.
 */
export function filenameFromUri(uri: string): string {
  try {
    const sourceUri = sharedPdfUri(uri) ?? uri;
    const decoded = decodeURIComponent(sourceUri);
    const basename = decoded.split('/').pop() ?? '';
    // Strip query-strings or fragments that iOS sometimes appends
    const clean = basename.split('?')[0].split('#')[0];
    if (clean.length > 0) return clean;
  } catch {}
  return `shared_plan_${Date.now()}.pdf`;
}

/**
 * Returns true when a URL looks like an iOS-shared PDF file.
 * Matches:
 *   - file:// URIs ending in .pdf
 *   - Any content:// URI with a .pdf extension (Android future-proofing)
 */
export function isSharedPdfUrl(url: string): boolean {
  return sharedPdfUri(url) !== null;
}

/**
 * Returns the actual PDF URI from a direct share URL or from the app's
 * `plans-mobile://open?url=…` custom-scheme entry point.
 */
export function sharedPdfUri(url: string): string | null {
  let candidate = url;

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'plans-mobile:') {
      candidate = parsed.searchParams.get('url') ?? '';
    }
  } catch {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    const supportedProtocol =
      parsed.protocol === 'file:' ||
      parsed.protocol === 'content:' ||
      parsed.protocol === 'https:';
    return supportedProtocol && parsed.pathname.toLowerCase().endsWith('.pdf')
      ? candidate
      : null;
  } catch {
    return null;
  }
}
