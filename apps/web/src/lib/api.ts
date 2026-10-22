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
  suspended?: boolean;
}

export interface SessionInfo {
  user: { id: string; email: string; isPlatformAdmin?: boolean };
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
  motionEnabled: boolean;
  motionSensitivity: number;
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
  locationId?: string;
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
  type:
    | "CAMERA_OFFLINE"
    | "RECORDING_STOPPED"
    | "STORAGE_QUOTA_WARNING"
    | "UPLOAD_FAILURE"
    | "RETENTION_CLEANUP_FAILURE"
    | "MOTION_DETECTED"
    | "PERSON_DETECTED"
    | "VEHICLE_DETECTED";
  eventId?: string | null;
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

export { API_BASE_URL };

// --- Live view -------------------------------------------------------------

export function startLive(cameraId: string) {
  return apiFetch<{ cameraId: string; protocol: "hls"; playlistUrl: string }>(`/cameras/${cameraId}/live/start`, {
    method: "POST",
  });
}

// --- Locations -------------------------------------------------------------

export interface Location {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  createdAt: string;
  cameraCount: number;
}

export function listLocations() {
  return apiFetch<{ locations: Location[] }>("/locations");
}

export function createLocation(input: { name: string; address?: string | null; timezone?: string }) {
  return apiFetch<Location>("/locations", { method: "POST", body: JSON.stringify(input) });
}

export function updateLocation(id: string, input: { name?: string; address?: string | null; timezone?: string }) {
  return apiFetch<Location>(`/locations/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteLocation(id: string) {
  return apiFetch<void>(`/locations/${id}`, { method: "DELETE" });
}

export function assignCamerasToLocation(id: string, cameraIds: string[]) {
  return apiFetch<{ assigned: number }>(`/locations/${id}/cameras`, {
    method: "POST",
    body: JSON.stringify({ cameraIds }),
  });
}

export function setCameraLocation(cameraId: string, locationId: string | null) {
  return apiFetch<Camera>(`/cameras/${cameraId}`, { method: "PATCH", body: JSON.stringify({ locationId }) });
}

// --- Integrations ----------------------------------------------------------

export interface IntegrationCatalogItem {
  key: string;
  name: string;
  status: "available" | "built_in" | "planned";
  description: string;
}

export interface Integration {
  id: string;
  provider: "webhook";
  name: string;
  url: string | null;
  events: string[];
  isEnabled: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  createdAt: string;
  signingSecret?: string;
}

export function listIntegrations() {
  return apiFetch<{ catalog: IntegrationCatalogItem[]; eventTypes: string[]; integrations: Integration[] }>(
    "/integrations",
  );
}

export function createWebhook(input: { name: string; url: string; events: string[] }) {
  return apiFetch<Integration>("/integrations", {
    method: "POST",
    body: JSON.stringify({ provider: "webhook", ...input }),
  });
}

export function updateIntegration(
  id: string,
  input: { name?: string; url?: string; events?: string[]; isEnabled?: boolean; rotateSecret?: boolean },
) {
  return apiFetch<Integration>(`/integrations/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteIntegration(id: string) {
  return apiFetch<void>(`/integrations/${id}`, { method: "DELETE" });
}

export function testIntegration(id: string) {
  return apiFetch<{ ok: boolean; status: number | null; error?: string }>(`/integrations/${id}/test`, {
    method: "POST",
  });
}

// --- Account / settings ----------------------------------------------------

export interface AccountInfo {
  user: { id: string; email: string; displayName: string | null; createdAt: string; passwordChangedAt: string | null };
  memberships: { tenantId: string; tenantName: string; role: TenantMembership["role"] }[];
}

export function getAccount() {
  return apiFetch<AccountInfo>("/account");
}

export function updateProfile(displayName: string | null) {
  return apiFetch<{ user: AccountInfo["user"] }>("/account/profile", {
    method: "PATCH",
    body: JSON.stringify({ displayName }),
  });
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiFetch<{ ok: boolean; otherSessionsRevoked: number }>("/account/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function listSessions() {
  return apiFetch<{ sessions: { id: string; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean; clientType?: string; deviceName?: string | null }[] }>(
    "/account/sessions",
  );
}

export function revokeOtherSessions() {
  return apiFetch<{ revoked: number }>("/account/sessions/revoke-others", { method: "POST" });
}

export function getNotificationPreferences() {
  return apiFetch<{ types: Notification["type"][]; mutedTypes: Notification["type"][] }>(
    "/account/notification-preferences",
  );
}

export function setNotificationPreferences(mutedTypes: Notification["type"][]) {
  return apiFetch<{ types: Notification["type"][]; mutedTypes: Notification["type"][] }>(
    "/account/notification-preferences",
    { method: "PUT", body: JSON.stringify({ mutedTypes }) },
  );
}

// --- Motion detection ------------------------------------------------------

export interface MotionSettings {
  cameraId: string;
  enabled: boolean;
  sensitivity: number;
  threshold: number;
  alertClasses: AlertClass[];
  lastCheckedAt: string | null;
  lastError: string | null;
}

export type AlertClass = "any" | "person" | "vehicle";

export interface MotionEvent {
  id: string;
  cameraId: string;
  cameraName: string;
  score: number;
  threshold: number;
  detectedAt: string;
  labels: { label: string; category: string; score: number }[] | null;
  hasSnapshot: boolean;
}

export function getMotionSettings(cameraId: string) {
  return apiFetch<MotionSettings>(`/cameras/${cameraId}/motion`);
}

export function getSnapshotUrl(eventId: string) {
  return apiFetch<{ url: string; expiresInSeconds: number }>(`/motion-events/${eventId}/snapshot`);
}

export function setMotionSettings(cameraId: string, input: { enabled: boolean; sensitivity?: number; alertClasses?: AlertClass[] }) {
  return apiFetch<MotionSettings>(`/cameras/${cameraId}/motion`, { method: "PUT", body: JSON.stringify(input) });
}

export function listCameraMotionEvents(cameraId: string, limit = 20) {
  return apiFetch<{ events: MotionEvent[] }>(`/cameras/${cameraId}/motion/events?limit=${limit}`);
}

export function listMotionEvents(limit = 50) {
  return apiFetch<{ events: MotionEvent[] }>(`/motion-events?limit=${limit}`);
}

// --- Team: members + invites ----------------------------------------------

export type Role = TenantMembership["role"];

export interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  joinedAt: string;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  state: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: string | null;
}

export function listMembers() {
  return apiFetch<{ currentUserId: string; currentRole: Role; members: Member[] }>("/members");
}

export function changeMemberRole(userId: string, role: Role) {
  return apiFetch<{ userId: string; role: Role }>(`/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
}

export function removeMember(userId: string) {
  return apiFetch<void>(`/members/${userId}`, { method: "DELETE" });
}

export function listInvites() {
  return apiFetch<{ invites: Invite[]; mailConfigured: boolean }>("/invites");
}

export function createInvite(email: string, role: Role) {
  return apiFetch<{ invite: Invite; acceptUrl: string; emailSent: boolean }>("/invites", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export function revokeInvite(id: string) {
  return apiFetch<void>(`/invites/${id}`, { method: "DELETE" });
}

export function previewInvite(token: string) {
  return apiFetch<{ email: string; role: Role; workspaceName: string; expiresAt: string; accountExists: boolean }>(
    `/invites/token/${encodeURIComponent(token)}`,
  );
}

export function acceptInvite(input: { token: string; password?: string; displayName?: string }) {
  return apiFetch<{ workspace: { id: string; name: string }; role: Role }>("/invites/accept", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function switchTenant(tenantId: string) {
  return apiFetch<void>("/auth/switch-tenant", { method: "POST", body: JSON.stringify({ tenantId }) });
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; error?: string; details?: { message?: string }[] } | undefined;
    return body?.message ?? body?.details?.[0]?.message ?? body?.error ?? fallback;
  }
  return fallback;
}

// --- Web Push ---------------------------------------------------------------

export interface PushDevice {
  id: string;
  service: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}

export function getPushConfig() {
  return apiFetch<{ enabled: boolean; publicKey: string | null }>("/push/config");
}

export function listPushDevices() {
  return apiFetch<{ enabled: boolean; subscriptions: PushDevice[] }>("/push/subscriptions");
}

export function savePushSubscription(sub: PushSubscriptionJSON, userAgent: string) {
  return apiFetch<PushDevice>("/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, userAgent: userAgent.slice(0, 300) }),
  });
}

export function removePushDevice(id: string) {
  return apiFetch<void>(`/push/subscriptions/${id}`, { method: "DELETE" });
}

export function sendTestPush() {
  return apiFetch<{ devices: number; sent: number }>("/push/test", { method: "POST" });
}

// --- Retention ----------------------------------------------------------------

export interface RetentionInfo {
  workspaceRetentionDays: number | null;
  planMaxRetentionDays: number | null;
  totalBytes: string;
  canEdit: boolean;
  cameras: {
    cameraId: string;
    cameraName: string;
    overrideDays: number | null;
    effectiveDays: number | null;
    bytes: string;
    segmentCount: number;
    oldestRecordingAt: string | null;
  }[];
}

export function getRetention() {
  return apiFetch<RetentionInfo>("/retention");
}

export function setWorkspaceRetention(retentionDays: number | null) {
  return apiFetch<{ workspaceRetentionDays: number | null }>("/retention", { method: "PUT", body: JSON.stringify({ retentionDays }) });
}

export function setCameraRetention(cameraId: string, retentionDays: number | null) {
  return apiFetch<{ cameraId: string; overrideDays: number | null }>(`/retention/cameras/${cameraId}`, {
    method: "PUT",
    body: JSON.stringify({ retentionDays }),
  });
}

// --- Platform admin ----------------------------------------------------------

export interface AdminStats {
  tenants: { total: number; suspended: number };
  users: { total: number; suspended: number };
  cameras: { total: number; recording: number };
  storage: { bytes: number };
  recordings: { segments: number };
  alerts: { total: number; last24h: number };
  sessions: { active: number; mobile: number };
}
export interface AdminTenant {
  id: string; name: string; createdAt: string; suspendedAt: string | null; suspendedReason: string | null;
  members: number; cameras: number; alerts: number; storageBytes: number; segments: number;
}
export interface AdminUser {
  id: string; email: string; displayName: string | null; createdAt: string; suspendedAt: string | null;
  suspendedReason: string | null; isPlatformAdmin: boolean; activeSessions: number;
  workspaces: { id: string; name: string; role: string }[];
}
export interface AdminCamera {
  id: string; name: string; connectorType: string; manufacturer: string | null; model: string | null;
  motionEnabled: boolean; createdAt: string; recording: boolean; motionEvents: number;
  tenant: { id: string; name: string; suspendedAt: string | null };
}
export interface AdminAuditEntry {
  id: string; action: string; targetType: string; targetId: string; metadata: Record<string, unknown> | null;
  actorEmail: string | null; createdAt: string;
}
type Page<K extends string, T> = { total: number; page: number; pageSize: number } & Record<K, T[]>;
function adminQuery(q?: string, page = 1) {
  const p = new URLSearchParams({ page: String(page) });
  if (q) p.set("q", q);
  return p.toString();
}
export const adminStats = () => apiFetch<AdminStats>("/platform-admin/stats");
export const adminTenants = (q?: string, page?: number) => apiFetch<Page<"tenants", AdminTenant>>(`/platform-admin/tenants?${adminQuery(q, page)}`);
export const adminUsers = (q?: string, page?: number) => apiFetch<Page<"users", AdminUser>>(`/platform-admin/users?${adminQuery(q, page)}`);
export const adminCameras = (q?: string, page?: number) => apiFetch<Page<"cameras", AdminCamera>>(`/platform-admin/cameras?${adminQuery(q, page)}`);
export const adminAudit = (page?: number) => apiFetch<{ entries: AdminAuditEntry[] }>(`/platform-admin/audit?${adminQuery(undefined, page)}`);
export function adminSetSuspended(kind: "tenants" | "users", id: string, suspend: boolean, reason?: string) {
  return apiFetch<unknown>(`/platform-admin/${kind}/${id}/${suspend ? "suspend" : "unsuspend"}`, {
    method: "POST",
    body: JSON.stringify(suspend ? { reason } : {}),
  });
}
