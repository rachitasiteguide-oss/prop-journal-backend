import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { AppError } from '../../middlewares/errorHandler';
import { logger } from '../../utils/logger';
import {
  buildScreenshotKey,
  isAllowedImageType,
  MAX_UPLOAD_BYTES,
  screenshotPrefix,
} from './keyBuilder';
import type {
  PresignUploadInput,
  PresignUploadResult,
  StorageProvider,
} from './types';

// Backs both Cloudflare R2 and AWS S3 — the protocol is identical, only the
// endpoint and region differ. Picks the R2 endpoint when R2_* vars are
// present, falls back to AWS S3 otherwise.

export class S3Provider implements StorageProvider {
  readonly name: string;
  private readonly bucket: string | undefined;
  private client: S3Client | null = null;

  constructor() {
    if (env.R2_ACCOUNT_ID) {
      this.name = 'r2';
      this.bucket = env.R2_BUCKET_NAME;
    } else {
      this.name = 's3';
      this.bucket = env.AWS_S3_BUCKET;
    }
  }

  isConfigured(): boolean {
    if (this.name === 'r2') {
      return Boolean(
        env.R2_ACCOUNT_ID &&
          env.R2_ACCESS_KEY_ID &&
          env.R2_SECRET_ACCESS_KEY &&
          env.R2_BUCKET_NAME,
      );
    }
    return Boolean(
      env.AWS_S3_BUCKET &&
        env.AWS_S3_REGION &&
        env.AWS_ACCESS_KEY_ID &&
        env.AWS_SECRET_ACCESS_KEY,
    );
  }

  expectedKeyPrefix(userId: string, tradeId: string): string {
    return screenshotPrefix(userId, tradeId);
  }

  private ensure(): S3Client {
    if (!this.isConfigured()) {
      throw new AppError(
        `Storage provider "${this.name}" is missing credentials`,
        503,
      );
    }
    if (this.client) return this.client;
    this.client =
      this.name === 'r2'
        ? new S3Client({
            region: 'auto',
            endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
              accessKeyId: env.R2_ACCESS_KEY_ID!,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
            },
          })
        : new S3Client({
            region: env.AWS_S3_REGION!,
            credentials: {
              accessKeyId: env.AWS_ACCESS_KEY_ID!,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
            },
          });
    return this.client;
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignUploadResult> {
    if (!isAllowedImageType(input.contentType)) {
      throw new AppError('Only PNG, JPEG, WEBP, or GIF images are accepted', 400);
    }
    if (input.contentLength <= 0 || input.contentLength > MAX_UPLOAD_BYTES) {
      throw new AppError(
        `File size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`,
        400,
      );
    }
    const key = buildScreenshotKey(input.userId, input.tradeId, input.filename);
    const expiresIn = 300;
    const uploadUrl = await getSignedUrl(
      this.ensure(),
      new PutObjectCommand({
        Bucket: this.bucket!,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn },
    );
    return { uploadUrl, method: 'PUT', key, expiresIn };
  }

  async presignRead(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(
      this.ensure(),
      new GetObjectCommand({ Bucket: this.bucket!, Key: key }),
      { expiresIn },
    );
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.ensure().send(
        new HeadObjectCommand({ Bucket: this.bucket!, Key: key }),
      );
      return true;
    } catch (e) {
      logger.warn(`${this.name} HEAD failed for ${key}: ${(e as Error).message}`);
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.ensure().send(
      new DeleteObjectCommand({ Bucket: this.bucket!, Key: key }),
    );
  }
}
