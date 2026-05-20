import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_CALLBACK_URL: z.string().url('GOOGLE_CALLBACK_URL must be a valid URL'),

  CLIENT_URL: z.string().url('CLIENT_URL must be a valid URL').default('http://localhost:3000'),

  RESEND_API_KEY: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('Prop Journal <noreply@propjournal.app>'),

  // AI trade coach. Anthropic = production (Claude Haiku), Groq = free testing
  // tier. If neither key is set the service falls back to a deterministic
  // rule-based analyzer so the feature still works offline / in tests.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  // Economic calendar (JBlanked free Forex Factory feed). Optional: when the
  // key is absent the calendar service returns an empty feed instead of
  // throwing, so the dashboard degrades gracefully and tests stay offline.
  JBLANKED_API_KEY: z.string().optional(),

  // ── File storage (trade screenshots) ──────────────────────────────────────
  // Provider-agnostic: pick via STORAGE_PROVIDER, then set the matching block
  // of credentials. When the chosen provider's creds are missing the storage
  // endpoints return 503 cleanly so the rest of the app still boots.
  //
  // Defaults to auto-detect: cloudinary if CLOUDINARY_CLOUD_NAME is present,
  // else R2 if R2_ACCOUNT_ID is present, else S3, else "not configured".
  STORAGE_PROVIDER: z.enum(['auto', 'r2', 's3', 'cloudinary']).default('auto'),

  // Cloudflare R2 (S3-compatible). Free tier: 10 GB + 10 M reads/mo, no egress.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),

  // AWS S3. Free tier: 5 GB / 2 K PUT / 20 K GET, expires after 12 months.
  AWS_S3_BUCKET: z.string().optional(),
  AWS_S3_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // Cloudinary. Free tier: 25 credits/mo (storage + bandwidth shared budget),
  // no credit card required, automatic WebP/AVIF optimisation included.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  COOKIE_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
