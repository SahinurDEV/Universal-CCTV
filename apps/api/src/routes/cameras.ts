import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { assertSafeCameraHost, UnsafeCameraHostError } from "../lib/network-guard.js";
import { encryptSecret } from "../lib/crypto.js";
import { writeAuditLog } from "../lib/audit.js";
import { EMPTY_CAPABILITIES } from "@cctv/shared";

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
    createdAt: camera.createdAt,
    updatedAt: camera.updatedAt,
    hasCredential: camera.credential != null,
    capability: toCapabilityResponse(camera.capability),
    // No connector (RTSP/ONVIF/SIMULATED) actually dials a camera yet —
    // that's Phase 4. A camera can be registered today but nothing connects
    // to it; the UI must not imply otherwise.
    connectionImplemented: false,
  };
}

camerasRouter.post("/", requireRole("OWNER", "ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createCameraSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const { name, locationId, connectorType, host, port, onvifPort, credential } = parsed.data;

  try {
    assertSafeCameraHost(host);
  } catch (err) {
    if (err instanceof UnsafeCameraHostError) {
      return res.status(400).json({ error: "unsafe_host", message: err.message });
    }
    throw err;
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
});

camerasRouter.get("/", async (req, res) => {
  const cameras = await prisma.camera.findMany({
    where: { tenantId: req.authTenant!.id },
    include: { credential: true, capability: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ cameras: cameras.map(serializeCamera) });
});

camerasRouter.get("/:id", async (req, res) => {
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
});

const updateCameraSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  locationId: z.string().uuid().nullable().optional(),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  onvifPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  credential: credentialSchema.optional(),
});

camerasRouter.patch("/:id", requireRole("OWNER", "ADMIN", "OPERATOR"), async (req, res) => {
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
    try {
      assertSafeCameraHost(fields.host);
    } catch (err) {
      if (err instanceof UnsafeCameraHostError) {
        return res.status(400).json({ error: "unsafe_host", message: err.message });
      }
      throw err;
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
});

camerasRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res) => {
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
});
