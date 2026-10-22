import type { NotificationType } from "@prisma/client";

export const NOTIFICATION_TYPES: NotificationType[] = [
  "CAMERA_OFFLINE",
  "RECORDING_STOPPED",
  "STORAGE_QUOTA_WARNING",
  "UPLOAD_FAILURE",
  "RETENTION_CLEANUP_FAILURE",
  "MOTION_DETECTED",
];

export function mutedTypesFrom(prefs: unknown): NotificationType[] {
  if (!prefs || typeof prefs !== "object") return [];
  const muted = (prefs as { mutedTypes?: unknown }).mutedTypes;
  if (!Array.isArray(muted)) return [];
  return muted.filter((t): t is NotificationType => NOTIFICATION_TYPES.includes(t as NotificationType));
}
