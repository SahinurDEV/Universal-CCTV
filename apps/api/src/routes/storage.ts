import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const storageRouter = Router();

/**
 * Storage actually occupied right now — sums real segment file sizes for
 * `COMPLETE` and `EXPIRED` segments (EXPIRED means "marked for deletion,"
 * not "already deleted"; its S3 object still exists until retention
 * enforcement actually removes it). `DELETED`/`UPLOAD_FAILED`/`RECORDING`
 * segments have no object occupying real storage right now, so they're
 * excluded — this is a live figure, not a historical ingest total.
 */
storageRouter.get("/usage", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const tenantId = req.authTenant!.id;

  const segments = await prisma.recordingSegment.groupBy({
    by: ["cameraId"],
    where: { tenantId, status: { in: ["COMPLETE", "EXPIRED"] } },
    _sum: { fileSizeBytes: true },
    _count: { _all: true },
  });

  const cameras = await prisma.camera.findMany({
    where: { tenantId },
    select: { id: true, name: true },
  });
  const cameraNames = new Map(cameras.map((c) => [c.id, c.name]));

  const byCamera = segments.map((s) => ({
    cameraId: s.cameraId,
    cameraName: cameraNames.get(s.cameraId) ?? "(deleted camera)",
    bytes: (s._sum.fileSizeBytes ?? 0n).toString(),
    segmentCount: s._count._all,
  }));

  const totalBytes = byCamera.reduce((sum, c) => sum + BigInt(c.bytes), 0n);

  res.json({ totalBytes: totalBytes.toString(), byCamera });
}));
