-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "cameras" ADD COLUMN     "alert_schedule" JSONB,
ADD COLUMN     "detection_thresholds" JSONB,
ADD COLUMN     "detection_zones" JSONB;

