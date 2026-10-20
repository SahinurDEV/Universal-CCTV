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

export function deleteCamera(id: string) {
  return apiFetch<void>(`/cameras/${id}`, { method: "DELETE" });
}
