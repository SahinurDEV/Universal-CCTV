-- AlterTable
ALTER TABLE "integration_configs" ADD COLUMN     "encrypted_secret" TEXT,
ADD COLUMN     "last_delivery_at" TIMESTAMP(3),
ADD COLUMN     "last_delivery_status" TEXT,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "secret_iv" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "notification_preferences" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "password_changed_at" TIMESTAMP(3);
