import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { S3Provider } from './s3Provider';
import { CloudinaryProvider } from './cloudinaryProvider';
import type { StorageProvider } from './types';

export type { StorageProvider, PresignUploadInput, PresignUploadResult } from './types';
export { buildScreenshotKey, screenshotPrefix, isAllowedImageType, MAX_UPLOAD_BYTES } from './keyBuilder';

// ── Provider selection ───────────────────────────────────────────────────────
// Resolution order:
//   1. STORAGE_PROVIDER if set explicitly (r2 / s3 / cloudinary)
//   2. Auto: cloudinary if its creds are present, else R2 if its creds are
//      present, else S3.
// Result is cached so we don't rebuild the S3Client / re-call cloudinary.config
// on every request.

let cached: StorageProvider | null = null;

function chooseProvider(): StorageProvider {
  const explicit = env.STORAGE_PROVIDER;
  if (explicit === 'cloudinary') return new CloudinaryProvider();
  if (explicit === 'r2' || explicit === 's3') return new S3Provider();

  // explicit === 'auto'
  if (env.CLOUDINARY_CLOUD_NAME) {
    return new CloudinaryProvider();
  }
  return new S3Provider();
}

export function getStorageProvider(): StorageProvider {
  if (cached) return cached;
  cached = chooseProvider();
  logger.info(
    `Storage provider: ${cached.name} (${cached.isConfigured() ? 'configured' : 'NOT configured'})`,
  );
  return cached;
}

// Test hook — let unit tests drop a stub provider in.
export function _setStorageProviderForTests(p: StorageProvider | null): void {
  cached = p;
}
