import { prisma } from "./db.js";

export async function getActiveSubscription(tenantId: string) {
  return prisma.subscription.findUnique({
    where: { tenantId },
    include: { plan: true },
  });
}

export async function getCameraCount(tenantId: string): Promise<number> {
  return prisma.camera.count({ where: { tenantId } });
}

/**
 * Real storage currently occupied — same definition as `GET /storage/usage`
 * (COMPLETE + EXPIRED segments; see routes/storage.ts for why EXPIRED still
 * counts). Kept as a shared helper so quota enforcement and the reporting
 * endpoint can never silently disagree about what "storage used" means.
 */
export async function getStorageBytesUsed(tenantId: string): Promise<bigint> {
  const result = await prisma.recordingSegment.aggregate({
    where: { tenantId, status: { in: ["COMPLETE", "EXPIRED"] } },
    _sum: { fileSizeBytes: true },
  });
  return result._sum.fileSizeBytes ?? 0n;
}
