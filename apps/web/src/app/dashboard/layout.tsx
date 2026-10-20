"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { listNotifications, logout } from "@/lib/api";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/cameras", label: "Cameras" },
  { href: "/dashboard/live-view", label: "Live View" },
  { href: "/dashboard/recordings", label: "Recordings" },
  { href: "/dashboard/storage", label: "Storage" },
  { href: "/dashboard/locations", label: "Locations" },
  { href: "/dashboard/alerts", label: "Alerts" },
  { href: "/dashboard/integrations", label: "Integrations" },
  { href: "/dashboard/subscription", label: "Subscription" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (session.status === "unauthenticated") {
      router.push("/login");
    }
  }, [session.status, router]);

  useEffect(() => {
    if (session.status !== "authenticated") return;
    function refresh() {
      listNotifications()
        .then((res) => setUnreadCount(res.unreadCount))
        .catch(() => {
          /* non-fatal — the nav badge just won't update */
        });
    }
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [session.status]);

  if (session.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Loading...
      </div>
    );
  }

  if (session.status === "unauthenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Redirecting to login...
      </div>
    );
  }

  const activeTenant = session.session.tenants.find((t) => t.id === session.session.activeTenantId);

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 flex-shrink-0 border-r border-slate-800 p-4">
        <div className="mb-6 px-2">
          <p className="font-semibold">Universal CCTV</p>
          <p className="truncate text-xs text-slate-400">{activeTenant?.name ?? "No workspace"}</p>
        </div>
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
                  isActive ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-white"
                }`}
              >
                <span>{item.label}</span>
                {item.href === "/dashboard/alerts" && unreadCount > 0 && (
                  <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-xs text-white">
                    {unreadCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
          <span className="text-sm text-slate-400">{session.session.user.email}</span>
          <button onClick={handleLogout} className="text-sm text-slate-400 hover:text-white">
            Log out
          </button>
        </header>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
