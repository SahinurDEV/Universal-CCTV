import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma client instance for the process. In dev with `tsx watch`, this
 * guards against exhausting DB connections on hot reload by reusing a global.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
