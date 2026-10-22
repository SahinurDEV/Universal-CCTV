/**
 * Platform super-admin management — the ONLY way (besides the
 * PLATFORM_ADMIN_EMAILS env var) to grant the role. Run on the server:
 *   pnpm --filter @cctv/api admin:grant  user@example.com
 *   pnpm --filter @cctv/api admin:revoke user@example.com
 *   pnpm --filter @cctv/api admin:list
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [cmd, rawEmail] = process.argv.slice(2);
  if (cmd === "list") {
    const admins = await prisma.user.findMany({ where: { isPlatformAdmin: true }, select: { email: true, createdAt: true } });
    const env = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
    console.log("Granted via CLI:", admins.length ? admins.map((a) => a.email).join(", ") : "(none)");
    console.log("From PLATFORM_ADMIN_EMAILS:", env.length ? env.join(", ") : "(none)");
    return;
  }
  if ((cmd !== "grant" && cmd !== "revoke") || !rawEmail) {
    console.error("usage: platform-admin.ts grant|revoke <email> | list");
    process.exitCode = 2;
    return;
  }
  const email = rawEmail.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with email ${email}. They must register first.`);
    process.exitCode = 1;
    return;
  }
  const grant = cmd === "grant";
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: grant } }),
    prisma.platformAuditLog.create({
      data: { actorUserId: null, action: grant ? "admin.grant" : "admin.revoke", targetType: "User", targetId: user.id, metadata: { email, via: "cli" } },
    }),
  ]);
  console.log(`${grant ? "Granted" : "Revoked"} platform admin for ${email}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
