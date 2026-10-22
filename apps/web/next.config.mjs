const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4100").origin;
  } catch {
    return "http://localhost:4100";
  }
})();

// Security headers for every page. connect-src/media-src allow the API
// origin (JSON + live HLS) and the signed S3 playback URLs (https:, plus the
// local S3 endpoint in dev).
const isDev = process.env.NODE_ENV !== "production";
// Local setups (API on localhost) also need the local S3 endpoint, e.g.
// http://localhost:4566, for recording playback — even in a production build.
const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(apiOrigin);
// Extra origins for signed playback URLs, e.g. a custom S3/CDN domain.
const extraMedia = (process.env.NEXT_PUBLIC_MEDIA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean).join(" ");
const localSrc = isDev || isLocal ? " http://localhost:* http://127.0.0.1:*" : "";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${apiOrigin} https: ${extraMedia}${localSrc}${isDev ? " ws://localhost:*" : ""}`,
  `media-src 'self' blob: ${apiOrigin} https: ${extraMedia}${localSrc}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
