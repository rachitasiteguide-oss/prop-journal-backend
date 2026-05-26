import { v2 as cloudinary } from "cloudinary";
import { env } from "../../config/env";
import { AppError } from "../../middlewares/errorHandler";
import { logger } from "../../utils/logger";
import {
  buildScreenshotKey,
  isAllowedImageType,
  MAX_UPLOAD_BYTES,
  screenshotPrefix,
} from "./keyBuilder";
import type {
  PresignUploadInput,
  PresignUploadResult,
  StorageProvider,
} from "./types";

// Cloudinary "signed upload" flow:
//   1. Backend signs a set of upload parameters with the api_secret.
//   2. Client POSTs FormData (file + api_key + timestamp + signature + ...)
//      to https://api.cloudinary.com/v1_1/{cloud}/upload.
//   3. Cloudinary returns metadata; the public_id we asked for is now stored.
//
// We reuse the same `screenshots/{userId}/{tradeId}/...` shape as the S3
// providers so the controller's ownership prefix-check works unchanged.

export class CloudinaryProvider implements StorageProvider {
  readonly name = "cloudinary";
  private configured = false;

  constructor() {
    if (this.isConfigured()) {
      cloudinary.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME!,
        api_key: env.CLOUDINARY_API_KEY!,
        api_secret: env.CLOUDINARY_API_SECRET!,
        secure: true,
      });
      this.configured = true;
    }
  }

  isConfigured(): boolean {
    return Boolean(
      env.CLOUDINARY_CLOUD_NAME &&
      env.CLOUDINARY_API_KEY &&
      env.CLOUDINARY_API_SECRET,
    );
  }

  expectedKeyPrefix(userId: string, tradeId: string): string {
    return screenshotPrefix(userId, tradeId);
  }

  private ensure(): void {
    if (!this.configured) {
      throw new AppError(
        'Storage provider "cloudinary" is missing credentials',
        503,
      );
    }
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignUploadResult> {
    this.ensure();
    if (!isAllowedImageType(input.contentType)) {
      throw new AppError(
        "Only PNG, JPEG, WEBP, or GIF images are accepted",
        400,
      );
    }
    if (input.contentLength <= 0 || input.contentLength > MAX_UPLOAD_BYTES) {
      throw new AppError(
        `File size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`,
        400,
      );
    }

    const key = buildScreenshotKey(input.userId, input.tradeId, input.filename);

    // remove extension from Cloudinary public_id
    const publicId = key.replace(/\.[^/.]+$/, "");

    const timestamp = Math.floor(Date.now() / 1000);

    const params = {
      public_id: publicId,
      timestamp,
    };
    const signature = cloudinary.utils.api_sign_request(
      params,
      env.CLOUDINARY_API_SECRET!,
    );

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      method: "POST",
      key,
      formFields: {
        api_key: env.CLOUDINARY_API_KEY!,
        timestamp: String(timestamp),
        signature,
        public_id: publicId,
      },
      expiresIn: 3600,
    };
  }

  async presignRead(key: string): Promise<string> {
    this.ensure();

    const publicId = key.replace(/\.[^/.]+$/, "");

    return cloudinary.url(publicId, {
      secure: true,
    });
  }

  async objectExists(key: string): Promise<boolean> {
    this.ensure();
    try {
      const publicId = key.replace(/\.[^/.]+$/, "");

      await cloudinary.api.resource(publicId, {
        resource_type: "image",
      });
      return true;
    } catch (e) {
      logger.warn(
        `cloudinary lookup failed for ${key}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.ensure();
    const publicId = key.replace(/\.[^/.]+$/, "");

    await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
    });
  }
}
