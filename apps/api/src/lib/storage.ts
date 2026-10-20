import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadEnv } from "../env.js";

let client: S3Client | undefined;

function getClient(): S3Client {
  if (client) return client;
  const env = loadEnv();
  client = new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

/**
 * Object key scheme per docs/architecture.md:
 * tenants/{tenantId}/cameras/{cameraId}/recordings/{date}/{recordingId}.mp4
 * `date` is the segment's UTC calendar date (YYYY-MM-DD) so a tenant's
 * footage for a given day lives under one prefix.
 */
export function buildRecordingObjectKey(
  tenantId: string,
  cameraId: string,
  segmentStart: Date,
  recordingId: string,
): string {
  const date = segmentStart.toISOString().slice(0, 10);
  return `tenants/${tenantId}/cameras/${cameraId}/recordings/${date}/${recordingId}.mp4`;
}

export async function uploadRecordingSegment(objectKey: string, body: Buffer): Promise<void> {
  const env = loadEnv();
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: objectKey,
      Body: body,
      ContentType: "video/mp4",
    }),
  );
}

/**
 * Short-lived signed GET URL for a recording segment — never make a
 * recording's object public; this is the only sanctioned way a browser gets
 * at the bytes. Expires after SIGNED_URL_TTL_SECONDS (default 300s).
 *
 * `downloadFilename`, when set, adds a Content-Disposition: attachment
 * header to the response so clicking it downloads rather than navigates —
 * same object, same short-lived URL mechanism, just a different intent.
 */
export async function getSignedPlaybackUrl(
  objectKey: string,
  opts?: { downloadFilename?: string },
): Promise<string> {
  const env = loadEnv();
  const command = new GetObjectCommand({
    Bucket: env.STORAGE_BUCKET,
    Key: objectKey,
    ResponseContentDisposition: opts?.downloadFilename
      ? `attachment; filename="${opts.downloadFilename}"`
      : undefined,
  });
  return getSignedUrl(getClient(), command, { expiresIn: env.SIGNED_URL_TTL_SECONDS });
}

/**
 * Permanently deletes a recording's object. Only ever called by retention
 * enforcement (recording/retention.ts) after the DB has already marked the
 * segment EXPIRED — deleting here is the point of no return, so callers
 * must have already decided the deletion is authorized before reaching this.
 */
export async function deleteRecordingSegment(objectKey: string): Promise<void> {
  const env = loadEnv();
  await getClient().send(new DeleteObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: objectKey }));
}
