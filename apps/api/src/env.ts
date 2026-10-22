import { z } from "zod";

const DEV_APP_SECRET = "dev-only-insecure-secret-change-me-please-32chars";

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
    .default(DEV_APP_SECRET),

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
  // NOTE: not z.coerce.boolean() — that turns the string "false" into true
  // (any non-empty string is truthy), so STORAGE_FORCE_PATH_STYLE=false for
  // real AWS S3 was silently ignored.
  STORAGE_FORCE_PATH_STYLE: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // MediaMTX's two HTTP APIs (see docker-compose.yml / infra/mediamtx/mediamtx.yml).
  // Config API: add/remove per-camera recording paths. Playback API: list/fetch
  // completed segments. Both are unauthenticated in local dev on purpose — see
  // the warning in infra/mediamtx/mediamtx.yml and docs/security.md.
  MEDIAMTX_API_URL: z.string().default("http://localhost:9997"),
  MEDIAMTX_PLAYBACK_URL: z.string().default("http://localhost:9996"),
  // MediaMTX HLS server. Browsers never reach it directly — apps/api proxies
  // live-view requests to it after checking the session + tenant.
  MEDIAMTX_HLS_URL: z.string().default("http://localhost:8888"),
  // Directory (as seen by the MediaMTX process) where recordings are written.
  // "/recordings" matches the Docker volume; a native MediaMTX install
  // usually points this at a writable local folder instead.
  MEDIAMTX_RECORD_DIR: z.string().default("/recordings"),
  // Host that SIMULATED (fake test) cameras must use. Simulated cameras are a
  // dev/test fixture; set ALLOW_SIMULATED_CAMERAS=false in production.
  ALLOW_SIMULATED_CAMERAS: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  // Comma-separated hostnames/IPs the server must never dial for camera
  // probes, in addition to the built-in loopback/link-local/metadata list.
  CAMERA_HOST_DENYLIST: z.string().default(""),
  // Set "true" to also block RFC1918 private ranges (10/8, 172.16/12,
  // 192.168/16) for camera hosts. Recommended for multi-tenant cloud
  // deployments where cameras are reached over the internet; leave off
  // for self-hosted installs where cameras sit on the same LAN.
  BLOCK_PRIVATE_CAMERA_HOSTS: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // --- Motion detection (worker) ---
  // The worker reads each motion-enabled camera through MediaMTX's RTSP
  // server (never dials the camera a second time) and samples frames with
  // ffmpeg's scene-change filter.
  MEDIAMTX_RTSP_URL: z.string().default("rtsp://localhost:8554"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  MOTION_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(20),
  MOTION_SAMPLE_SECONDS: z.coerce.number().int().min(1).max(30).default(4),
  // Minimum minutes between two MOTION_DETECTED alerts for one camera
  // (every detection is still stored as a MotionEvent).
  MOTION_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),

  // --- Invites / email ---
  // Public URL of the web app; used to build invite accept links.
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3100"),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  // Optional SMTP server, e.g. smtp://user:pass@smtp.example.com:587 . When
  // unset, invite links are not emailed: they are shown once to the admin
  // who created the invite (and logged in development only).
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Universal CCTV <no-reply@localhost>"),

  // --- Object detection (people / vehicles) ---
  // SSD MobileNet v1 (COCO, Apache-2.0, ONNX model zoo), run on CPU with
  // onnxruntime-node. Downloaded by `pnpm --filter @cctv/api model:download`
  // or automatically on first use; never committed to git.
  DETECTION_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  DETECTION_MODEL_PATH: z.string().default("models/ssd_mobilenet_v1_12.onnx"),
  DETECTION_MODEL_URL: z
    .string()
    .url()
    .default(
      "https://github.com/onnx/models/raw/main/validated/vision/object_detection_segmentation/ssd-mobilenetv1/model/ssd_mobilenet_v1_12.onnx",
    ),
  // Download is rejected unless the file matches this hash. Empty = skip check.
  DETECTION_MODEL_SHA256: z
    .string()
    .default("b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058"),
  DETECTION_AUTO_DOWNLOAD: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  DETECTION_MIN_SCORE: z.coerce.number().min(0.05).max(0.99).default(0.5),

  // --- Web Push (VAPID) ---
  // Generate with: pnpm --filter @cctv/api exec web-push generate-vapid-keys
  // All three unset = push disabled (the rest of the app works normally).
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@localhost"),
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

  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    // Refuse to boot production with the published dev default secret.
    if (env.APP_SECRET === DEV_APP_SECRET) {
      throw new Error("Invalid environment configuration:\n  - APP_SECRET: must be set to a unique value in production");
    }
    if (env.CORS_ORIGIN === "*") {
      throw new Error("Invalid environment configuration:\n  - CORS_ORIGIN: must not be '*' (credentials are sent cross-origin)");
    }
  }
  if (env.ALLOW_SIMULATED_CAMERAS === undefined) {
    env.ALLOW_SIMULATED_CAMERAS = env.NODE_ENV !== "production";
  }

  cachedEnv = env;
  return cachedEnv;
}
