-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MOTION_DETECTED';

-- AlterTable
ALTER TABLE "cameras" ADD COLUMN     "motion_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "motion_last_checked_at" TIMESTAMP(3),
ADD COLUMN     "motion_last_error" TEXT,
ADD COLUMN     "motion_sensitivity" INTEGER NOT NULL DEFAULT 50;

-- CreateTable
CREATE TABLE "motion_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "motion_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "motion_events_tenant_id_detected_at_idx" ON "motion_events"("tenant_id", "detected_at");

-- CreateIndex
CREATE INDEX "motion_events_camera_id_detected_at_idx" ON "motion_events"("camera_id", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_tenant_id_created_at_idx" ON "invites"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "invites_email_idx" ON "invites"("email");

-- AddForeignKey
ALTER TABLE "motion_events" ADD CONSTRAINT "motion_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "motion_events" ADD CONSTRAINT "motion_events_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
