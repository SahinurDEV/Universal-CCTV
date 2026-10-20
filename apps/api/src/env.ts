import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Default is 4100, not the more common 4000: this dev machine already has
  // an unrelated process bound to 4000.
  PORT: z.coerce.number().int().positive().default(4100),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // General-purpose HMAC secret, used for future signed tokens (email
  // verification, password reset) — not for session auth, which uses
  // DB-backed opaque tokens (see lib/sessions.ts) specifically so sessions
  // can be revoked server-side.
  APP_SECRET: z
    .string()
    .min(32, "APP_SECRET must be at least 32 characters")
    .optional()
    .default("dev-only-insecure-secret-change-me-please-32chars"),

  // AES-256-GCM key for encrypting camera credentials (RTSP username/password)
  // at rest. 32 raw bytes, hex-encoded (64 hex characters). No default — a
  // camera credential encrypted with a default key is not actually protected.
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"),

  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // S3-compatible object storage (LocalStack locally, AWS S3 in production).
  STORAGE_ENDPOINT: z.string().min(1, "STORAGE_ENDPOINT is required"),
  STORAGE_REGION: z.string().default("us-east-1"),
  STORAGE_BUCKET: z.string().min(1, "STORAGE_BUCKET is required"),
  STORAGE_ACCESS_KEY_ID: z.string().min(1, "STORAGE_ACCESS_KEY_ID is required"),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1, "STORAGE_SECRET_ACCESS_KEY is required"),
  STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // Fail fast and loud. Never start the server with an invalid/missing config.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
