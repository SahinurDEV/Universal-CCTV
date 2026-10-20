import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      authUser?: { id: string; email: string };
      authSession?: { id: string; activeTenantId: string | null };
      authTenant?: { id: string; role: Role };
    }
  }
}

export {};
