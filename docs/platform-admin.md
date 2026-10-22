# Platform admin (super-admin) dashboard

A **platform admin** is the operator of the whole deployment, not a member
of a workspace. The role is completely separate from workspace roles
(OWNER / ADMIN / OPERATOR / VIEWER): a workspace OWNER has no platform
access, and a platform admin gets no workspace permissions from it.

## Granting the role (server-side only)

There is **no API or UI to grant it**, so nobody can make themselves an
admin. Use either:

- **CLI** (recorded in the platform audit log as `admin.grant` / `admin.revoke`):
  ```bash
  pnpm --filter @cctv/api admin:grant  ops@example.com
  pnpm --filter @cctv/api admin:revoke ops@example.com
  pnpm --filter @cctv/api admin:list
  ```
  The user must have registered first.
- **Env**: `PLATFORM_ADMIN_EMAILS=ops@example.com,other@example.com`
  (comma-separated, case-insensitive). Useful for infrastructure-as-code.
  Restart the API after changing it.

## Using it

Sign in to the web dashboard; admins see **Platform admin** in the sidebar
(`/dashboard/admin`). Tabs:

- **Overview**: workspaces, users, cameras (and how many are recording),
  storage used, recording segments, alerts (total / last 24h), active
  sessions (and how many are mobile).
- **Workspaces**: search, members, cameras, storage, alerts; **Suspend** /
  **Unsuspend**.
- **Users**: search by email/name, workspaces and roles, active sessions;
  **Suspend** / **Unsuspend**.
- **Cameras**: every camera with its workspace, type, recording and motion
  status. No hosts, RTSP paths or credentials are shown.
- **Audit log**: every admin action with who, when, target and reason.

Suspending asks for a reason (3–500 characters), which is stored in the audit log.

## What suspension does

| | Workspace suspended | User suspended |
|---|---|---|
| API access | every workspace-scoped route returns `403 tenant_suspended` for all members | all sessions (web + mobile) revoked immediately; every request returns 401/403 |
| Login | members can still sign in (to see the notice or switch to another workspace) | `403 account_suspended`, shown **only after a correct password** so it can't be used to enumerate accounts |
| Live view / playback | blocked | blocked |
| Motion / detection alerts | paused (the worker skips the workspace's cameras) | n/a |
| Push | FCM tokens kept; no new alerts are generated | FCM tokens deleted |
| Recording already running | **keeps running** so evidence isn't lost; stop it after unsuspending, or delete the workspace data separately | n/a |
| Data | kept | kept |

Web and mobile both show a "workspace suspended" banner.

Guard rails: admins can't suspend themselves or another platform admin (revoke the role with the CLI first). Suspend and unsuspend are rate-limited (30 per minute per IP). The status change and the audit row are written in **one transaction**, so an action can't happen without being recorded.

## API

All routes are under `/platform-admin` and need `requireAuth` + `requirePlatformAdmin`. They only accept a **browser cookie session**; mobile bearer tokens are rejected even for admins.

`GET /stats`, `GET /tenants?q=&page=&pageSize=`, `GET /tenants/:id`,
`GET /users`, `GET /cameras`, `GET /audit`,
`POST /tenants/:id/suspend {reason}`, `POST /tenants/:id/unsuspend`,
`POST /users/:id/suspend {reason}`, `POST /users/:id/unsuspend`.

`/auth/me` returns `user.isPlatformAdmin`, and `suspended` on each workspace.

Tests: `apps/api/src/routes/platform-admin.integration.test.ts` and `src/lib/platform-admin.test.ts`.

## Dashboard UI

`/dashboard/admin` opens a full-screen admin console (sidebar navigation,
light/dark toggle remembered in `localStorage["admin-theme"]`, responsive with
a slide-out menu on phones):

- **Overview**: KPI cards (workspaces, users, cameras, storage, alerts, active
  sessions) with week-over-week trend badges, and charts for cameras, storage
  and daily alerts/recordings over 7/30/90 days, from
  `GET /platform-admin/timeseries?days=7..90` (UTC days; cameras and storage
  are running totals, the rest per-day counts; trends compare the last 7 days
  with the previous 7).
- **Workspaces / Users / Cameras**: searchable tables with status filters
  (`status=all|active|suspended`), a camera type filter (`type=RTSP|ONVIF|SIMULATED`),
  avatars, status/role badges and numbered pagination. Suspending opens a
  dialog that requires a reason.
- **Audit log**: every admin action, newest first.

Charts use `recharts` (MIT) and icons `lucide-react` (ISC).
