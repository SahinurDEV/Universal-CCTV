/**
 * Canonical camera capability model. This is the only shape written to
 * `camera_capabilities` in the database — every field must come from an actual
 * connector probe (detectCapabilities), never inferred from a model name.
 */
export interface CameraCapabilities {
  liveView: boolean;
  cloudRecording: boolean;
  playback: boolean;
  ptz: boolean;
  zoom: boolean;
  motionEvents: boolean;
  imageSettings: boolean;
  audio: boolean;
  firmwareUpdate: boolean;
}

export const EMPTY_CAPABILITIES: CameraCapabilities = {
  liveView: false,
  cloudRecording: false,
  playback: false,
  ptz: false,
  zoom: false,
  motionEvents: false,
  imageSettings: false,
  audio: false,
  firmwareUpdate: false,
};

/**
 * Support tier shown in the UI. Derived from CameraCapabilities + connection
 * outcome — never set directly by a connector.
 */
export type CameraSupportTier =
  | "fully_supported"
  | "partially_supported"
  | "connected_missing_capabilities"
  | "unsupported";

export function deriveSupportTier(opts: {
  streamConfirmed: boolean;
  onvifReachable: boolean;
  claimedCapabilities: Partial<CameraCapabilities>;
  confirmedCapabilities: CameraCapabilities;
}): CameraSupportTier {
  if (!opts.streamConfirmed) return "unsupported";
  if (!opts.onvifReachable) return "connected_missing_capabilities";

  const claimedKeys = Object.entries(opts.claimedCapabilities).filter(
    ([, v]) => v === true,
  );
  const allClaimedConfirmed = claimedKeys.every(
    ([k]) => opts.confirmedCapabilities[k as keyof CameraCapabilities] === true,
  );

  return allClaimedConfirmed ? "fully_supported" : "partially_supported";
}
