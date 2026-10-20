// Loaded before any test module, so env.ts's validation never fails during
// `pnpm test`. These point at throwaway/unreachable targets on purpose —
// tests that need a real DB/Redis/MinIO are integration tests gated on
// docker-compose being up (see docs/testing.md), not this unit test run.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test_db";
process.env.REDIS_URL ??= "redis://localhost:6399"; // unreachable on purpose in plain unit test runs
process.env.STORAGE_ENDPOINT ??= "http://localhost:9000";
process.env.STORAGE_BUCKET ??= "test-bucket";
process.env.STORAGE_ACCESS_KEY_ID ??= "test-access-key";
process.env.STORAGE_SECRET_ACCESS_KEY ??= "test-secret-key";
process.env.APP_SECRET ??= "unit-test-app-secret-not-for-real-use-00000";
process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "0".repeat(64); // 32 zero bytes — fine for unit tests that never decrypt real data
