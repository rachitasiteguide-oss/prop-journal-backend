// Shared shape used by every storage provider so the controller / frontend
// don't care whether the bytes land in R2, S3, or Cloudinary.

export interface PresignUploadInput {
  userId: string;
  tradeId: string;
  filename: string;
  contentType: string;
  contentLength: number;
}

export interface PresignUploadResult {
  // Where the client sends the bytes.
  uploadUrl: string;
  // How. S3/R2 use a presigned PUT; Cloudinary uses a multipart POST.
  method: 'PUT' | 'POST';
  // The opaque identifier the server stores on the Trade row. Must start
  // with the provider's user/trade prefix so the controller's ownership
  // check still works.
  key: string;
  // Extra fields the client must include in the multipart form body
  // (Cloudinary needs api_key, timestamp, signature, public_id, folder).
  // Empty for S3/R2.
  formFields?: Record<string, string>;
  // Lifetime of the presigned URL, in seconds.
  expiresIn: number;
}

export interface StorageProvider {
  /** Stable identifier for logs / responses (`r2`, `s3`, `cloudinary`). */
  readonly name: string;
  /** True when the provider has all credentials it needs to operate. */
  isConfigured(): boolean;
  /** Build a per-user, per-trade key prefix for ownership checks. */
  expectedKeyPrefix(userId: string, tradeId: string): string;
  presignUpload(input: PresignUploadInput): Promise<PresignUploadResult>;
  presignRead(key: string, expiresIn?: number): Promise<string>;
  objectExists(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
}
