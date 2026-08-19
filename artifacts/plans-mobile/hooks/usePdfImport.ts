import { useCallback } from 'react';
import { Alert } from 'react-native';
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
      // Resolve file size when not provided (e.g. file:// URIs from Share Sheet)
      let fileSize = size;
      if (fileSize == null) {
        try {
          const info = await FileSystem.getInfoAsync(uri);
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

      await FileSystem.copyAsync({ from: uri, to: destPath });

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
    const decoded = decodeURIComponent(uri);
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
  const lower = url.toLowerCase();
  return (lower.startsWith('file://') || lower.startsWith('content://')) &&
    lower.split('?')[0].endsWith('.pdf');
}
