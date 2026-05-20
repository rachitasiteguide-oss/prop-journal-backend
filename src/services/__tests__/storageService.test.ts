import { describe, it, expect } from 'vitest';
import {
  buildScreenshotKey,
  isAllowedImageType,
  MAX_UPLOAD_BYTES,
} from '../storageService';

describe('buildScreenshotKey', () => {
  it('namespaces by userId then tradeId so per-user listing/quota is trivial', () => {
    const k = buildScreenshotKey('user1', 'trade1', 'chart.png', new Date(1000));
    expect(k).toBe('screenshots/user1/trade1/1000-chart.png');
  });

  it('slugifies the filename to remove slashes and other unsafe path chars', () => {
    const k = buildScreenshotKey('u', 't', '../../etc/passwd', new Date(0));
    // Slashes get replaced; the literal dots survive as text (R2 keys are
    // opaque strings so this is safe — there is no filesystem traversal).
    expect(k).not.toContain('/etc/');
    expect(k).not.toContain('\\');
    expect(k.startsWith('screenshots/u/t/0-')).toBe(true);
  });

  it('forces a fallback filename when the input slugs to nothing', () => {
    const k = buildScreenshotKey('u', 't', '!!!', new Date(0));
    expect(k).toBe('screenshots/u/t/0-screenshot.png');
  });

  it('truncates very long filenames to keep keys S3-safe', () => {
    const long = 'a'.repeat(500) + '.png';
    const k = buildScreenshotKey('u', 't', long, new Date(0));
    // 80 chars from the slugged name, plus the prefix and timestamp.
    expect(k.length).toBeLessThan(150);
    expect(k.startsWith('screenshots/u/t/0-')).toBe(true);
  });
});

describe('isAllowedImageType', () => {
  it('allows the common chart-screenshot formats', () => {
    expect(isAllowedImageType('image/png')).toBe(true);
    expect(isAllowedImageType('image/jpeg')).toBe(true);
    expect(isAllowedImageType('image/webp')).toBe(true);
    expect(isAllowedImageType('image/gif')).toBe(true);
  });

  it('is case-insensitive (browsers sometimes report Image/PNG)', () => {
    expect(isAllowedImageType('Image/PNG')).toBe(true);
  });

  it('rejects executables and PDFs even if mis-labelled as images', () => {
    expect(isAllowedImageType('application/pdf')).toBe(false);
    expect(isAllowedImageType('application/octet-stream')).toBe(false);
    expect(isAllowedImageType('text/html')).toBe(false);
  });
});

describe('MAX_UPLOAD_BYTES', () => {
  it('is 10 MB — large enough for 4K screenshots, small enough to stop abuse', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
