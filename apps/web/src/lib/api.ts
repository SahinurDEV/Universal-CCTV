const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4100";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}

export interface TenantMembership {
  id: string;
  name: string;
  role: "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";
}

export interface SessionInfo {
  user: { id: string; email: string };
  tenants: TenantMembership[];
  activeTenantId: string | null;
}

export function register(input: { email: string; password: string; tenantName: string }) {
  return apiFetch<{ user: { id: string; email: string }; tenant: TenantMembership }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function login(input: { email: string; password: string }) {
  return apiFetch<SessionInfo>("/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export function logout() {
  return apiFetch<void>("/auth/logout", { method: "POST" });
}

export function fetchMe() {
  return apiFetch<SessionInfo>("/auth/me");
}

export interface CameraCapability {
  supportTier: "FULLY_SUPPORTED" | "PARTIALLY_SUPPORTED" | "CONNECTED_MISSING_CAPABILITIES" | "UNSUPPORTED";
  liveView: boolean;
  cloudRecording: boolean;
  playback: boolean;
  ptz: boolean;
  zoom: boolean;
  motionEvents: boolean;
  imageSettings: boolean;
  audio: boolean;
  firmwareUpdate: boolean;
  detectedAt: string;
}

export interface Camera {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  connectorType: "RTSP" | "ONVIF" | "SIMULATED";
  host: string;
  port: number;
  onvifPort: number | null;
  locationId: string | null;
  retentionPolicyId: string | null;
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
  capability: CameraCapability | null;
  connectionImplemented: boolean;
}

export function listCameras() {
  return apiFetch<{ cameras: Camera[] }>("/cameras");
}

export function getCamera(id: string) {
  return apiFetch<Camera>(`/cameras/${id}`);
}

export interface CreateCameraInput {
  name: string;
  connectorType: "RTSP" | "ONVIF" | "SIMULATED";
  host: string;
  port: number;
  onvifPort?: number;
  credential?: { username?: string; password?: string; path?: string };
}

export function createCamera(input: CreateCameraInput) {
  return apiFetch<Camera>("/cameras", { method: "POST", body: JSON.stringify(input) });
}

export function updateCameraRetentionPolicy(id: string, retentionPolicyId: string) {
  return apiFetch<Camera>(`/cameras/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ retentionPolicyId }),
  });
}

export interface RetentionPolicy {
  id: string;
  name: string;
  retentionDays: number;
  isDefault: boolean;
}

export function listRetentionPolicies() {
  return apiFetch<{ policies: RetentionPolicy[] }>("/retention-policies");
}

export interface StorageUsage {
  totalBytes: string;
  byCamera: Array<{ cameraId: string; cameraName: string; bytes: string; segmentCount: number }>;
}

export function getStorageUsage() {
  return apiFetch<StorageUsage>("/storage/usage");
}

export function deleteCamera(id: string) {
  return apiFetch<void>(`/cameras/${id}`, { method: "DELETE" });
}

export interface TestConnectionResult {
  ok: boolean;
  supportTier: CameraCapability["supportTier"];
  capability: Omit<CameraCapability, "supportTier" | "detectedAt">;
  streams: Array<{ codecType: string; codecName: string; width?: number; height?: number }>;
  error: { reason: "timeout" | "connection_failed"; message: string } | null;
}

export function testCameraConnection(id: string) {
  return apiFetch<TestConnectionResult>(`/cameras/${id}/test-connection`, { method: "POST" });
}

export interface DiscoveredDevice {
  host: string;
  port: number;
  onvifServiceUrl: string | null;
}

export function discoverCameras(timeoutMs = 5000) {
  return apiFetch<{ devices: DiscoveredDevice[]; note: string }>("/cameras/discover", {
    method: "POST",
    body: JSON.stringify({ timeoutMs }),
  });
}

export interface RecordingStatus {
  active: boolean;
  jobId: string | null;
  status: "PENDING" | "RUNNING" | null;
  startedAt: string | null;
  segmentSeconds: number | null;
  segmentCount: number;
}

export function getRecordingStatus(cameraId: string) {
  return apiFetch<RecordingStatus>(`/cameras/${cameraId}/recording`);
}

export function startRecording(cameraId: string, segmentSeconds = 60) {
  return apiFetch<{ jobId: string; status: string; startedAt: string }>(
    `/cameras/${cameraId}/recording/start`,
    { method: "POST", body: JSON.stringify({ segmentSeconds }) },
  );
}

export function stopRecording(cameraId: string) {
  return apiFetch<{ jobId: string; status: string; ingested: number; failed: number }>(
    `/cameras/${cameraId}/recording/stop`,
    { method: "POST" },
  );
}

export interface RecordingSegmentSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  fileSizeBytes: string | null;
  status: "RECORDING" | "COMPLETE" | "UPLOAD_FAILED" | "EXPIRED" | "DELETED";
}

export function listRecordingDates(cameraId: string) {
  return apiFetch<{ dates: string[] }>(`/cameras/${cameraId}/recordings/dates`);
}

export function listRecordings(cameraId: string, date: string) {
  return apiFetch<{ segments: RecordingSegmentSummary[] }>(
    `/cameras/${cameraId}/recordings?date=${encodeURIComponent(date)}`,
  );
}

export function getPlaybackUrl(cameraId: string, segmentId: string, download = false) {
  return apiFetch<{ url: string; expiresInSeconds: number }>(
    `/cameras/${cameraId}/recordings/${segmentId}/url${download ? "?download=true" : ""}`,
  );
}

export interface SubscriptionPlan {
  id: string;
  key: string;
  name: string;
  cameraLimit: number;
  storageQuotaGb: number;
  maxRetentionDays: number;
  priceCentsMonthly: number;
  isActive: boolean;
}

export interface SubscriptionInfo {
  subscription: {
    id: string;
    status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED";
    billingProvider: string;
    currentPeriodEnd: string | null;
    plan: SubscriptionPlan;
  } | null;
  usage: {
    cameraCount: number;
    cameraLimit: number;
    storageBytesUsed: string;
    storageQuotaBytes: string;
  } | null;
}

export function getSubscription() {
  return apiFetch<SubscriptionInfo>("/subscription");
}

export function listPublicPlans() {
  return apiFetch<{ plans: SubscriptionPlan[] }>("/subscription/plans");
}

export function changeSubscriptionPlan(planKey: string) {
  return apiFetch<{ subscription: SubscriptionInfo["subscription"]; overCameraLimit: boolean }>(
    "/subscription/change",
    { method: "POST", body: JSON.stringify({ planKey }) },
  );
}

export function cancelSubscription() {
  return apiFetch<{ subscription: SubscriptionInfo["subscription"] }>("/subscription/cancel", {
    method: "POST",
  });
}

export interface Notification {
  id: string;
  type: "CAMERA_OFFLINE" | "RECORDING_STOPPED" | "STORAGE_QUOTA_WARNING" | "UPLOAD_FAILURE" | "RETENTION_CLEANUP_FAILURE";
  targetId: string | null;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export function listNotifications() {
  return apiFetch<{ notifications: Notification[]; unreadCount: number }>("/notifications");
}

export function markNotificationRead(id: string) {
  return apiFetch<Notification>(`/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead() {
  return apiFetch<void>("/notifications/read-all", { method: "POST" });
}
