// Thin compatibility wrapper around the provider-agnostic storage layer.
// All real work lives in `./storage/` — this file exists so existing imports
// (controllers, tests) keep working and so callers don't have to think about
// provider selection.

import { getStorageProvider } from './storage';
import type { PresignUploadInput, PresignUploadResult } from './storage/types';

export {
  buildScreenshotKey,
  screenshotPrefix,
  isAllowedImageType,
  MAX_UPLOAD_BYTES,
} from './storage/keyBuilder';

export type { PresignUploadInput, PresignUploadResult } from './storage/types';

export function isStorageConfigured(): boolean {
  return getStorageProvider().isConfigured();
}

export function storageProviderName(): string {
  return getStorageProvider().name;
}

export async function presignScreenshotUpload(
  input: PresignUploadInput,
): Promise<PresignUploadResult> {
  return getStorageProvider().presignUpload(input);
}

export async function presignScreenshotRead(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  return getStorageProvider().presignRead(key, expiresIn);
}

export async function objectExists(key: string): Promise<boolean> {
  return getStorageProvider().objectExists(key);
}

export async function deleteObject(key: string): Promise<void> {
  return getStorageProvider().deleteObject(key);
}
