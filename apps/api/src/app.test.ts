import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("GET /health", () => {
  it("returns 200 with no dependency checks", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /ready", () => {
  it("reports per-dependency status, 200 if healthy or 503 if degraded", async () => {
    const app = createApp();
    const res = await request(app).get("/ready");
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks).toHaveProperty("database");
    expect(res.body.checks).toHaveProperty("redis");
  });
});

describe("unknown route", () => {
  it("returns 404 with a stable error shape", async () => {
    const app = createApp();
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("async route error handling", () => {
  // Regression test for a real bug: stopping Postgres mid-request used to
  // crash the whole process (an unhandled promise rejection from an async
  // Express 4 route handler with no try/catch), not just fail one request —
  // confirmed by actually stopping the Postgres container against a running
  // dev server. See docs/failure-recovery.md. This unit test exercises the
  // same code path cheaply: in this suite's fake-env setup the DB URL is
  // unreachable, so GET /subscription/plans (no auth, queries Prisma
  // directly) throws for real; the app must survive and answer 500, not hang
  // or kill the process.
  it("returns 500 instead of crashing when a route's DB query rejects", async () => {
    const app = createApp();
    const res = await request(app).get("/subscription/plans");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
  });

  it("the process is still alive and serves a normal request right after", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
