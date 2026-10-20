-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "target_id" TEXT;

-- CreateIndex
CREATE INDEX "notifications_tenant_id_type_target_id_created_at_idx" ON "notifications"("tenant_id", "type", "target_id", "created_at");
