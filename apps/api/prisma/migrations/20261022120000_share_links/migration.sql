-- CreateEnum
CREATE TYPE "ShareKind" AS ENUM ('LIVE', 'CLIP');

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "camera_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "kind" "ShareKind" NOT NULL,
    "clip_start" TIMESTAMP(3),
    "clip_end" TIMESTAMP(3),
    "label" TEXT,
    "token_hash" TEXT NOT NULL,
    "password_hash" TEXT,
    "max_views" INTEGER,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_viewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");

-- CreateIndex
CREATE INDEX "share_links_tenant_id_created_at_idx" ON "share_links"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "share_links_camera_id_idx" ON "share_links"("camera_id");

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_camera_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "cameras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

