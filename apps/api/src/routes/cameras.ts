import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { assertSafeCameraHost, UnsafeCameraHostError } from "../lib/network-guard.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { writeAuditLog } from "../lib/audit.js";
import { EMPTY_CAPABILITIES, deriveSupportTier, type CameraCapabilities } from "@cctv/shared";
import { buildRtspUrl } from "../connectors/rtsp-url.js";
import { probeRtspStream, capabilitiesFromRtspProbe } from "../connectors/rtsp-probe.js";
import { discoverOnvifDevices } from "../connectors/onvif-discovery.js";
import { getActiveSubscription, getCameraCount } from "../lib/quota.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const camerasRouter = Router();

camerasRouter.use(requireAuth, requireTenant);

const credentialSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  path: z.string().optional(),
});

const createCameraSchema = z.object({
  name: z.string().min(1).max(200),
  locationId: z.string().uuid().optional(),
  connectorType: z.enum(["RTSP", "ONVIF", "SIMULATED"]),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  onvifPort: z.coerce.number().int().min(1).max(65535).optional(),
  credential: credentialSchema.optional(),
});

function toCapabilityResponse(capability: {
  supportTier: string;
  liveView: boolean;
  cloudRecording: boolean;
  playback: boolean;
  ptz: boolean;
  zoom: boolean;
  motionEvents: boolean;
  imageSettings: boolean;
  audio: boolean;
  firmwareUpdate: boolean;
  detectedAt: Date;
} | null) {
  if (!capability) return null;
  const { supportTier, detectedAt, ...flags } = capability;
  return { supportTier, detectedAt, ...flags };
}

function serializeCamera(camera: {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  connectorType: string;
  host: string;
  port: number;
  onvifPort: number | null;
  locationId: string | null;
  retentionPolicyId: string | null;
  createdAt: Date;
  updatedAt: Date;
  credential: unknown;
  capability: Parameters<typeof toCapabilityResponse>[0];
}) {
  return {
    id: camera.id,
    name: camera.name,
    manufacturer: camera.manufacturer,
    model: camera.model,
    connectorType: camera.connectorType,
    host: camera.host,
    port: camera.port,
    onvifPort: camera.onvifPort,
    locationId: camera.locationId,
    retentionPolicyId: camera.retentionPolicyId,
    createdAt: camera.createdAt,
    updatedAt: camera.updatedAt,
    hasCredential: camera.credential != null,
    capability: toCapabilityResponse(camera.capability),
    // POST /cameras/:id/test-connection actually probes the RTSP stream for
    // every connector type. What it CANNOT yet confirm: ONVIF-specific
    // capabilities (PTZ, motion events, etc.) — those stay false until a
    // real ONVIF capability probe is built, not just discovery.
    connectionImplemented: true,
  };
}

camerasRouter.post("/", requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const parsed = createCameraSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const { name, locationId, connectorType, host, port, onvifPort, credential } = parsed.data;

  // No subscription at all (e.g. plans never seeded) is treated as
  // unlimited rather than blocking every camera creation on a deployment
  // bug — see routes/subscription.ts's same tradeoff.
  const subscription = await getActiveSubscription(req.authTenant!.id);
  if (subscription) {
    const cameraCount = await getCameraCount(req.authTenant!.id);
    if (cameraCount >= subscription.plan.cameraLimit) {
      return res.status(402).json({
        error: "camera_limit_reached",
        message: `Your ${subscription.plan.name} plan allows up to ${subscription.plan.cameraLimit} cameras.`,
        limit: subscription.plan.cameraLimit,
      });
    }
  }

  // SIMULATED cameras point at our own dev-only media server fixture,
  // which is reachable at exactly "localhost" — the one host the SSRF guard
  // otherwise always blocks. This is NOT a blanket exemption for the
  // connector type: `host` is an ordinary user-supplied field independent
  // of `connectorType`, so a bypass here previously let anyone declare
  // `connectorType: "SIMULATED"` with an arbitrary internal host (e.g. the
  // cloud metadata address) and have the server actually dial it via
  // test-connection/recording-start. Pinning to the literal fixture address
  // closes that while still allowing the real simulated camera to work.
  if (connectorType === "SIMULATED") {
    if (host !== "localhost") {
      return res.status(400).json({
        error: "unsafe_host",
        message: 'Simulated cameras must use host "localhost" (the dev fixture address).',
      });
    }
  } else {
    try {
      assertSafeCameraHost(host);
    } catch (err) {
      if (err instanceof UnsafeCameraHostError) {
        return res.status(400).json({ error: "unsafe_host", message: err.message });
      }
      throw err;
    }
  }

  if (locationId) {
    const location = await prisma.location.findFirst({
      where: { id: locationId, tenantId: req.authTenant!.id },
    });
    if (!location) {
      return res.status(400).json({ error: "invalid_location" });
    }
  }

  const camera = await prisma.$transaction(async (tx) => {
    const created = await tx.camera.create({
      data: {
        tenantId: req.authTenant!.id,
        locationId: locationId ?? null,
        name,
        connectorType,
        host,
        port,
        onvifPort: onvifPort ?? null,
      },
    });

    if (credential && (credential.username || credential.password || credential.path)) {
      const encrypted = encryptSecret(JSON.stringify(credential));
      await tx.cameraCredential.create({
        data: {
          cameraId: created.id,
          encryptedValue: encrypted.ciphertext,
          encryptionIv: encrypted.iv,
        },
      });
    }

    // Honest default: no capability has been confirmed yet. Detection is
    // Phase 4 work — this row exists so the API/UI have something to read,
    // not because anything has been tested.
    await tx.cameraCapabilityRecord.create({
      data: {
        cameraId: created.id,
        supportTier: "UNSUPPORTED",
        ...EMPTY_CAPABILITIES,
      },
    });

    return tx.camera.findUniqueOrThrow({
      where: { id: created.id },
      include: { credential: true, capability: true },
    });
  });

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.create",
    targetType: "Camera",
    targetId: camera.id,
    metadata: { name, connectorType, host, port },
  });

  res.status(201).json(serializeCamera(camera));
}));

/**
 * ONVIF WS-Discovery: finds cameras on the SAME LAN as this API process.
 * This never saves anything — it just returns candidates for the "Add
 * Camera" UI to pre-fill, so a user doesn't have to know their camera's IP
 * address by heart. Only works for local/self-hosted deployments where the
 * API runs on the camera's network; see connectors/onvif-discovery.ts for
 * the cloud-deployment limitation.
 */
camerasRouter.post("/discover", asyncHandler(async (req, res) => {
  const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 5000, 1000), 15000);
  const devices = await discoverOnvifDevices(timeoutMs);
  res.json({
    devices,
    note: "Only finds cameras on the same local network as the server running this API.",
  });
}));

camerasRouter.get("/", asyncHandler(async (req, res) => {
  const cameras = await prisma.camera.findMany({
    where: { tenantId: req.authTenant!.id },
    include: { credential: true, capability: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ cameras: cameras.map(serializeCamera) });
}));

camerasRouter.get("/:id", asyncHandler(async (req, res) => {
  const camera = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
    include: { credential: true, capability: true },
  });
  if (!camera) {
    // Same 404 whether the camera doesn't exist or belongs to another
    // tenant — tenant isolation must not be observable via response shape.
    return res.status(404).json({ error: "not_found" });
  }
  res.json(serializeCamera(camera));
}));

const updateCameraSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  locationId: z.string().uuid().nullable().optional(),
  retentionPolicyId: z.string().uuid().nullable().optional(),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  onvifPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  credential: credentialSchema.optional(),
});

camerasRouter.patch("/:id", requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const existing = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
  });
  if (!existing) {
    return res.status(404).json({ error: "not_found" });
  }

  const parsed = updateCameraSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const { credential, ...fields } = parsed.data;

  if (fields.host) {
    if (existing.connectorType === "SIMULATED") {
      if (fields.host !== "localhost") {
        return res.status(400).json({
          error: "unsafe_host",
          message: 'Simulated cameras must use host "localhost" (the dev fixture address).',
        });
      }
    } else {
      try {
        assertSafeCameraHost(fields.host);
      } catch (err) {
        if (err instanceof UnsafeCameraHostError) {
          return res.status(400).json({ error: "unsafe_host", message: err.message });
        }
        throw err;
      }
    }
  }

  if (fields.locationId) {
    const location = await prisma.location.findFirst({
      where: { id: fields.locationId, tenantId: req.authTenant!.id },
    });
    if (!location) {
      return res.status(400).json({ error: "invalid_location" });
    }
  }

  if (fields.retentionPolicyId) {
    const policy = await prisma.retentionPolicy.findFirst({
      where: { id: fields.retentionPolicyId, tenantId: req.authTenant!.id },
    });
    if (!policy) {
      return res.status(400).json({ error: "invalid_retention_policy" });
    }

    const subscription = await getActiveSubscription(req.authTenant!.id);
    if (subscription && policy.retentionDays > subscription.plan.maxRetentionDays) {
      return res.status(402).json({
        error: "retention_exceeds_plan",
        message: `Your ${subscription.plan.name} plan allows up to ${subscription.plan.maxRetentionDays} days of retention.`,
        limit: subscription.plan.maxRetentionDays,
      });
    }
  }

  const camera = await prisma.$transaction(async (tx) => {
    const updated = await tx.camera.update({ where: { id: existing.id }, data: fields });

    if (credential) {
      const encrypted = encryptSecret(JSON.stringify(credential));
      await tx.cameraCredential.upsert({
        where: { cameraId: existing.id },
        create: { cameraId: existing.id, encryptedValue: encrypted.ciphertext, encryptionIv: encrypted.iv },
        update: { encryptedValue: encrypted.ciphertext, encryptionIv: encrypted.iv },
      });
    }

    return tx.camera.findUniqueOrThrow({
      where: { id: updated.id },
      include: { credential: true, capability: true },
    });
  });

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.update",
    targetType: "Camera",
    targetId: camera.id,
    metadata: { fields: Object.keys(fields) },
  });

  res.json(serializeCamera(camera));
}));

camerasRouter.delete("/:id", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const existing = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
  });
  if (!existing) {
    return res.status(404).json({ error: "not_found" });
  }

  await prisma.camera.delete({ where: { id: existing.id } });

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.delete",
    targetType: "Camera",
    targetId: existing.id,
  });

  // NOTE: this does not delete any S3 objects for the camera's recording
  // segments — orphaned-object cleanup is Phase 7 (retention/storage) work,
  // not implemented yet. Deleting a camera today can orphan stored video.
  res.status(204).send();
}));

/**
 * Actually attempts to connect to the camera's RTSP stream (via ffprobe) and
 * records what was found — this is the real connectivity check behind the
 * "Test Connection" UI action. It overwrites the camera's capability record
 * with what was *just* confirmed; it does not merge with or trust whatever
 * was there before, since stale "it worked last time" data is worse than no
 * data.
 */
camerasRouter.post("/:id/test-connection", requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const camera = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
    include: { credential: true },
  });
  if (!camera) {
    return res.status(404).json({ error: "not_found" });
  }

  let credentialParts: { username?: string; password?: string; path?: string } | undefined;
  if (camera.credential) {
    try {
      credentialParts = JSON.parse(
        decryptSecret({ ciphertext: camera.credential.encryptedValue, iv: camera.credential.encryptionIv }),
      );
    } catch {
      return res.status(500).json({ error: "credential_decrypt_failed" });
    }
  }

  const rtspUrl = buildRtspUrl(camera.host, camera.port, credentialParts);
  const probeResult = await probeRtspStream(rtspUrl);

  const confirmed: CameraCapabilities = probeResult.ok
    ? capabilitiesFromRtspProbe(probeResult.streams)
    : EMPTY_CAPABILITIES;

  // ONVIF capability confirmation (PTZ, motion events, etc.) isn't built
  // yet — only the RTSP stream itself is probed here, for every connector
  // type. So an ONVIF camera that streams fine still lands on
  // CONNECTED_MISSING_CAPABILITIES honestly, not FULLY_SUPPORTED.
  const onvifReachable = camera.connectorType !== "ONVIF";
  const supportTier = deriveSupportTier({
    streamConfirmed: probeResult.ok,
    onvifReachable,
    claimedCapabilities: confirmed,
    confirmedCapabilities: confirmed,
  });
  // The shared package's tier type is lowercase_snake_case; the Prisma enum
  // is UPPER_SNAKE_CASE. Same values, different casing convention per layer.
  const supportTierEnum = supportTier.toUpperCase() as
    | "FULLY_SUPPORTED"
    | "PARTIALLY_SUPPORTED"
    | "CONNECTED_MISSING_CAPABILITIES"
    | "UNSUPPORTED";

  await prisma.$transaction([
    prisma.cameraCapabilityRecord.update({
      where: { cameraId: camera.id },
      data: { supportTier: supportTierEnum, ...confirmed, detectedAt: new Date() },
    }),
    prisma.cameraConnectionSession.create({
      data: {
        cameraId: camera.id,
        status: probeResult.ok ? "ONLINE" : "OFFLINE",
        errorMessage: probeResult.ok ? null : probeResult.message,
        endedAt: new Date(),
      },
    }),
  ]);

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "camera.test_connection",
    targetType: "Camera",
    targetId: camera.id,
    metadata: probeResult.ok ? { ok: true } : { ok: false, reason: probeResult.reason },
  });

  res.json({
    ok: probeResult.ok,
    supportTier: supportTierEnum,
    capability: confirmed,
    streams: probeResult.ok
      ? probeResult.streams.map((s) => ({ codecType: s.codecType, codecName: s.codecName, width: s.width, height: s.height }))
      : [],
    error: probeResult.ok ? null : { reason: probeResult.reason, message: probeResult.message },
  });
}));
