-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PERSON_DETECTED';
ALTER TYPE "NotificationType" ADD VALUE 'VEHICLE_DETECTED';

-- AlterTable
ALTER TABLE "cameras" ADD COLUMN     "motion_alert_classes" TEXT[] DEFAULT ARRAY['any']::TEXT[],
ADD COLUMN     "retention_days_override" INTEGER;

-- AlterTable
ALTER TABLE "motion_events" ADD COLUMN     "labels" JSONB,
ADD COLUMN     "snapshot_key" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "event_id" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "retention_days" INTEGER;

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMP(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
