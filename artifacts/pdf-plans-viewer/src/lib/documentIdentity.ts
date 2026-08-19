/**
 * Builds the stable identity used for server registration and local pending
 * work. It deliberately uses the PDF bytes, not its filename or size: either
 * of those values can change or collide between unrelated documents.
 */
export async function getDocumentContentHash(file: Pick<Blob, 'arrayBuffer'>): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure PDF hashing is unavailable in this browser.');
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

/**
 * Kept only to remove mappings produced by older releases. This value must
 * never be used to look up a document because distinct PDFs can share it.
 */
export function getLegacyDocumentKey(file: Pick<File, 'name' | 'size'>): string {
  return `${file.name}-${file.size}`;
}