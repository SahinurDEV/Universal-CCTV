"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { listNotifications, logout, switchTenant } from "@/lib/api";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/cameras", label: "Cameras" },
  { href: "/dashboard/live-view", label: "Live View" },
  { href: "/dashboard/recordings", label: "Recordings" },
  { href: "/dashboard/storage", label: "Storage" },
  { href: "/dashboard/locations", label: "Locations" },
  { href: "/dashboard/alerts", label: "Alerts" },
  { href: "/dashboard/integrations", label: "Integrations" },
  { href: "/dashboard/team", label: "Team" },
  { href: "/dashboard/subscription", label: "Subscription" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile menu after navigating.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

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

  async function handleSwitchTenant(tenantId: string) {
    await switchTenant(tenantId);
    window.location.assign("/dashboard");
  }

  const tenants = session.session.tenants;

  return (
    <div className="min-h-screen md:flex">
      {navOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}
      <aside
        id="dashboard-nav"
        className={`fixed inset-y-0 left-0 z-40 w-64 transform overflow-y-auto border-r border-slate-800 bg-slate-950 p-4 transition-transform md:static md:w-56 md:flex-shrink-0 md:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-6 px-2">
          <p className="font-semibold">Universal CCTV</p>
          {tenants.length > 1 ? (
            <select
              aria-label="Switch workspace"
              value={session.session.activeTenantId ?? ""}
              onChange={(e) => handleSwitchTenant(e.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.role.toLowerCase()})
                </option>
              ))}
            </select>
          ) : (
            <p className="truncate text-xs text-slate-400">{activeTenant?.name ?? "No workspace"}</p>
          )}
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
          {session.session.user.isPlatformAdmin && (
            <Link
              href="/dashboard/admin"
              className={`mt-4 block rounded border border-violet-800 px-3 py-2 text-sm ${
                pathname === "/dashboard/admin" ? "bg-violet-900 text-white" : "text-violet-300 hover:bg-violet-950"
              }`}
            >
              Platform admin
            </Link>
          )}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-3 md:static md:px-6">
          <button
            type="button"
            onClick={() => setNavOpen((o) => !o)}
            className="whitespace-nowrap rounded border border-slate-700 px-2 py-1 text-sm text-slate-300 md:hidden"
            aria-controls="dashboard-nav"
            aria-expanded={navOpen}
            aria-label="Toggle navigation menu"
          >
            ☰ Menu
            {unreadCount > 0 && <span className="ml-1 rounded-full bg-amber-600 px-1.5 text-xs text-white">{unreadCount}</span>}
          </button>
          <span className="min-w-0 truncate text-sm text-slate-400">{session.session.user.email}</span>
          <button onClick={handleLogout} className="shrink-0 text-sm text-slate-400 hover:text-white">
            Log out
          </button>
        </header>
        {activeTenant?.suspended && pathname !== "/dashboard/admin" && (
          <div role="alert" className="border-b border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200 md:px-6">
            This workspace has been suspended by the platform operator. Cameras, live view and alerts are unavailable.
            Contact support to restore access.
          </div>
        )}
        <main className="p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
