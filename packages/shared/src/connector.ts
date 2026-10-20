import type { CameraCapabilities } from "./capabilities.js";

export type ConnectorType = "rtsp" | "onvif" | "simulated";

export interface CameraConnectionConfig {
  cameraId: string;
  tenantId: string;
  connectorType: ConnectorType;
  /** Reference to a secret, never the raw RTSP URL. Resolved server-side only. */
  credentialRef: string;
  host: string;
  port: number;
  onvifPort?: number;
}

export interface DiscoveredDevice {
  host: string;
  port: number;
  manufacturer?: string;
  model?: string;
  onvifServiceUrl?: string;
}

export interface DeviceInfo {
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  serialNumber?: string;
}

export interface StreamProfile {
  name: string;
  resolution: { width: number; height: number };
  codec: string;
  fps: number;
  bitrateKbps?: number;
}

export interface ImagingSettings {
  brightness?: number;
  contrast?: number;
  saturation?: number;
}

export interface MotionEventSubscription {
  supported: boolean;
}

export interface RecordingConfig {
  segmentSeconds: number;
}

export type ConnectionStatusValue = "online" | "offline" | "degraded" | "unknown";

export interface ConnectionStatus {
  status: ConnectionStatusValue;
  lastSuccessfulConnectionAt?: string;
  lastError?: string;
}

export interface StreamHandle {
  id: string;
  rtspUrl: string; // resolved server-side only; never serialized to the client
}

export interface PTZControl {
  move(direction: "up" | "down" | "left" | "right", speed: number): Promise<void>;
  stop(): Promise<void>;
  goToPreset?(presetId: string): Promise<void>;
}

/**
 * Every manufacturer/protocol adapter implements this interface. The rest of the
 * system (API routes, recording manager, UI) only ever talks to this interface —
 * never to a specific manufacturer's SDK directly.
 *
 * Optional methods are omitted entirely (not implemented as no-ops) by a connector
 * that cannot support them, so callers must feature-detect with `typeof fn === "function"`
 * rather than assuming presence.
 */
export interface CameraConnector {
  readonly type: ConnectorType;

  discover?(scope: { subnetCidr: string; timeoutMs: number }): Promise<DiscoveredDevice[]>;

  validateCredentials(config: CameraConnectionConfig): Promise<boolean>;

  openStream(config: CameraConnectionConfig): Promise<StreamHandle>;

  getDeviceInfo(config: CameraConnectionConfig): Promise<DeviceInfo>;

  detectCapabilities(config: CameraConnectionConfig): Promise<CameraCapabilities>;

  getStreamProfiles?(config: CameraConnectionConfig): Promise<StreamProfile[]>;

  getImagingSettings?(config: CameraConnectionConfig): Promise<ImagingSettings>;

  ptz?: PTZControl;

  getMotionEvents?(config: CameraConnectionConfig): Promise<MotionEventSubscription>;

  configureRecording?(config: CameraConnectionConfig, opts: RecordingConfig): Promise<void>;

  getConnectionStatus(config: CameraConnectionConfig): Promise<ConnectionStatus>;

  disconnect(handle: StreamHandle): Promise<void>;
}
