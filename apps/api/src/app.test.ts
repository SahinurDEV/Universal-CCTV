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
