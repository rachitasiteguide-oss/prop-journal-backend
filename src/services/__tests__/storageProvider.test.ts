import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset the cached provider between tests so each one sees a clean factory.
beforeEach(async () => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadModule() {
  return import('../storage');
}

describe('getStorageProvider — explicit selection', () => {
  it('honours STORAGE_PROVIDER=cloudinary when set', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'cloudinary');
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'x');
    vi.stubEnv('CLOUDINARY_API_KEY', 'y');
    vi.stubEnv('CLOUDINARY_API_SECRET', 'z');
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().name).toBe('cloudinary');
  });

  it('honours STORAGE_PROVIDER=r2 when set', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'r2');
    vi.stubEnv('R2_ACCOUNT_ID', 'acc');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'k');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 's');
    vi.stubEnv('R2_BUCKET_NAME', 'b');
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().name).toBe('r2');
  });

  it('honours STORAGE_PROVIDER=s3 when set', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 's3');
    vi.stubEnv('AWS_S3_BUCKET', 'b');
    vi.stubEnv('AWS_S3_REGION', 'us-east-1');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'k');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 's');
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().name).toBe('s3');
  });
});

describe('getStorageProvider — auto detection', () => {
  it('prefers cloudinary when its creds are present', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'auto');
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'x');
    vi.stubEnv('CLOUDINARY_API_KEY', 'y');
    vi.stubEnv('CLOUDINARY_API_SECRET', 'z');
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().name).toBe('cloudinary');
  });

  it('falls back to R2 when only R2 creds are present', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'auto');
    vi.stubEnv('R2_ACCOUNT_ID', 'acc');
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().name).toBe('r2');
  });

  it('falls back to S3 when no provider creds are configured at all', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'auto');
    const { getStorageProvider } = await loadModule();
    // Default fallthrough is the AWS S3 path (also "not configured" but the
    // provider object still exists so the 503-on-call path can fire cleanly).
    expect(getStorageProvider().name).toBe('s3');
  });
});

describe('provider configuration check', () => {
  it('isConfigured() is false when creds are missing — controller 503s instead of crashing', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 's3');
    // AWS vars omitted on purpose
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().isConfigured()).toBe(false);
  });

  it('isConfigured() is true once all required creds are in env', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'cloudinary');
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'x');
    vi.stubEnv('CLOUDINARY_API_KEY', 'y');
    vi.stubEnv('CLOUDINARY_API_SECRET', 'z');
    const { getStorageProvider } = await loadModule();
    expect(getStorageProvider().isConfigured()).toBe(true);
  });
});

describe('expectedKeyPrefix is identical across providers', () => {
  it('keeps the controller ownership-check provider-agnostic', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'r2');
    vi.stubEnv('R2_ACCOUNT_ID', 'a');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'b');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'c');
    vi.stubEnv('R2_BUCKET_NAME', 'd');
    const r2Mod = await loadModule();
    const r2Prefix = r2Mod.getStorageProvider().expectedKeyPrefix('u1', 't1');

    vi.resetModules();
    vi.stubEnv('STORAGE_PROVIDER', 'cloudinary');
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'a');
    vi.stubEnv('CLOUDINARY_API_KEY', 'b');
    vi.stubEnv('CLOUDINARY_API_SECRET', 'c');
    const cldMod = await loadModule();
    const cldPrefix = cldMod.getStorageProvider().expectedKeyPrefix('u1', 't1');

    expect(r2Prefix).toBe(cldPrefix);
    expect(r2Prefix).toBe('screenshots/u1/t1/');
  });
});
