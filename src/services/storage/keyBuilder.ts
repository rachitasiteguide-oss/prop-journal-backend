// Shared key/public_id shape across providers so the per-user prefix check
// in the controller continues to work regardless of which one is active.

export function buildScreenshotKey(
  userId: string,
  tradeId: string,
  filename: string,
  now: Date = new Date(),
): string {
  const slug = filename
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'screenshot.png';
  return `screenshots/${userId}/${tradeId}/${now.getTime()}-${slug}`;
}

export function screenshotPrefix(userId: string, tradeId: string): string {
  return `screenshots/${userId}/${tradeId}/`;
}

const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

export function isAllowedImageType(contentType: string): boolean {
  return ALLOWED.has(contentType.toLowerCase());
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
