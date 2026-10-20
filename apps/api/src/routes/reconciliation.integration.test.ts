import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { uploadRecordingSegment } from "../lib/storage.js";
import { reconcileOrphanedObjects } from "../recording/reconciliation.js";

const createdTenantIds: string[] = [];

async function s3ObjectExists(key: string): Promise<boolean> {
  const env = loadEnv();
  const client = new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY },
  });
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("reconcileOrphanedObjects against the real S3-compatible bucket", () => {
  it(
    "deletes an orphaned object with no matching recording_segments row, leaves a real segment's object alone, and skips an object younger than the age threshold",
    async () => {
      const tenant = await prisma.tenant.create({ data: { name: "Reconciliation Test Tenant" } });
      createdTenantIds.push(tenant.id);
      const camera = await prisma.camera.create({
        data: { tenantId: tenant.id, name: "Reconciliation Cam", connectorType: "SIMULATED", host: "localhost", port: 8554 },
      });
      const job = await prisma.recordingJob.create({
        data: { cameraId: camera.id, tenantId: tenant.id, status: "STOPPED" },
      });

      // A real orphan: uploaded directly, no DB row ever created for it —
      // simulates exactly what a camera-delete cascade or a crash-between-
      // upload-and-DB-write leaves behind.
      const orphanKey = `tenants/${tenant.id}/cameras/${camera.id}/recordings/test/orphan-${randomUUID()}.mp4`;
      await uploadRecordingSegment(orphanKey, Buffer.from("truly orphaned content"));

      // A real, legitimately-owned object — has a matching row, must survive.
      const ownedKey = `tenants/${tenant.id}/cameras/${camera.id}/recordings/test/owned-${randomUUID()}.mp4`;
      await uploadRecordingSegment(ownedKey, Buffer.from("owned content"));
      await prisma.recordingSegment.create({
        data: {
          tenantId: tenant.id,
          cameraId: camera.id,
          jobId: job.id,
          startedAt: new Date(),
          objectKey: ownedKey,
          fileSizeBytes: 13n,
          status: "COMPLETE",
          retentionExpiresAt: null,
        },
      });

      // Let the orphan and the owned object actually age past the threshold
      // below before checking — otherwise everything uploaded in this test
      // would look "fresh" and nothing would be eligible to delete.
      const MIN_AGE_MS = 2000;
      await new Promise((r) => setTimeout(r, MIN_AGE_MS + 500));

      // Another orphan, but freshly uploaded — must NOT be touched this run
      // even though it has no DB row, because it could still be mid-ingest.
      const freshOrphanKey = `tenants/${tenant.id}/cameras/${camera.id}/recordings/test/fresh-orphan-${randomUUID()}.mp4`;
      await uploadRecordingSegment(freshOrphanKey, Buffer.from("freshly uploaded, no row yet"));

      const result = await reconcileOrphanedObjects({ minAgeMs: MIN_AGE_MS });

      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await s3ObjectExists(orphanKey)).toBe(false);
      expect(await s3ObjectExists(ownedKey)).toBe(true);
      expect(await s3ObjectExists(freshOrphanKey)).toBe(true);

      // Clean up what the test intentionally left behind.
      const { deleteStorageObject } = await import("../lib/storage.js");
      await deleteStorageObject(ownedKey);
      await deleteStorageObject(freshOrphanKey);
    },
    20000,
  );
});
