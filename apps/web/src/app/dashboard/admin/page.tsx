"use client";

import { AdminConsole } from "@/components/admin/AdminConsole";
import { useSession } from "@/lib/useSession";

export default function PlatformAdminPage() {
  const session = useSession();
  if (session.status !== "authenticated") return null;
  if (!session.session.user.isPlatformAdmin) {
    return <p className="text-slate-400">This page is only for platform administrators.</p>;
  }
  return <AdminConsole self={{ id: session.session.user.id, email: session.session.user.email }} />;
}
