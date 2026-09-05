import type { Attachment } from '@jkj/shared';

/**
 * Reading files the browser hands us — from a paste, a drop, or a picker.
 *
 * The wire carries base64 because that is what the model takes for images,
 * and re-encoding once here is cheaper than inventing a second upload path.
 */

/** Kept well under the server's body limit, with room for several files. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function readFile(file: File): Promise<Attachment> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is ${Math.round(file.size / 1024 / 1024)} MB — too large to attach.`);
  }

  const buffer = await file.arrayBuffer();
  return {
    name: file.name || 'pasted',
    mediaType: file.type || guessType(file.name),
    data: toBase64(buffer),
  };
}

/** Files pasted from a screenshot arrive with no name and no type. */
function guessType(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return `image/${extension === 'jpg' ? 'jpeg' : extension}`;
  return 'text/plain';
}

/** btoa needs a binary string, and a big file must be fed to it in pieces. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export const isImage = (attachment: Attachment): boolean => attachment.mediaType.startsWith('image/');

export const previewUrl = (attachment: Attachment): string =>
  `data:${attachment.mediaType};base64,${attachment.data}`;
