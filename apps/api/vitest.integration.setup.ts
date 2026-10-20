// Integration tests talk to the real Postgres/Redis/LocalStack containers
// started by `docker compose up` (see docs/testing.md) — this loads the real
// apps/api/.env instead of the dummy values vitest.setup.ts uses for plain
// unit tests.
import "dotenv/config";
