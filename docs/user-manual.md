# Universal CCTV — User Manual

This guide is for people who **use** the platform: shop owners, home users,
security staff. No programming knowledge is needed.

---

## 1. What this app does

- Shows your cameras **live** in your web browser, from anywhere.
- **Records** your cameras to cloud storage.
- Lets you **watch and download** old recordings.
- **Alerts** you when a camera goes offline or storage is almost full.
- Works with almost any IP camera brand (Hikvision, Dahua, Reolink, Axis,
  TP-Link Tapo, Uniview, and any camera that supports RTSP or ONVIF).

---

## 2. Create your account

1. Open the website and click **Create a workspace** (or **Create one** on the login page).
2. Enter:
   - **Workspace name** — your business or home name (for example "Rahman Store").
   - **Email** and **Password** (at least 8 characters).
3. Click **Create workspace**. You are now signed in as the **Owner**.

To sign in later, click **Log in** and enter your email and password.

**Roles** (who can do what):

| Role | Can watch live & recordings | Add/edit cameras, record | Manage locations, integrations | Delete cameras, billing |
|---|---|---|---|---|
| Owner | ✅ | ✅ | ✅ | ✅ |
| Admin | ✅ | ✅ | ✅ | ✅ (not cancel) |
| Operator | ✅ | ✅ | assign cameras only | ❌ |
| Viewer | ✅ | ❌ | ❌ | ❌ |

---

## 3. Add a location (optional but recommended)

A location is a place, like "Home", "Shop" or "Warehouse". It helps you group
cameras.

1. Go to **Locations** → **Add location**.
2. Type a **name**, an optional **address**, and pick your **time zone**.
3. Click **Save**.

You can later move cameras between locations in the **Assign cameras** table
on the same page. Deleting a location never deletes its cameras.

---

## 4. Connect a camera

### 4.1 What you need from your camera

- The camera's **IP address** (for example `192.168.1.64`). Find it in the
  camera's own app, your router's "connected devices" list, or use
  **Scan network** on the Add camera form (works only when the server is on
  the same network as the camera).
- The camera's **username and password** (often `admin` + the password you
  set when you first installed the camera).
- **RTSP must be enabled** on the camera. On most brands it is on by default.
  On Tapo and Reolink you may need to turn it on (see the table below).

### 4.2 Add it

1. Go to **Cameras** → **Add camera**.
2. Fill in:
   - **Name** — e.g. "Front door".
   - **Location** — optional.
   - **Connector type** — choose **RTSP** for most cameras, or **ONVIF** if
     your camera supports ONVIF (this also detects PTZ/zoom/motion features).
   - **Host** — the camera's IP address or internet address (no `rtsp://`,
     no slashes).
   - **Port** — usually **554**.
   - **Username / Password** — the camera login.
   - **Path** — the part after the port in the RTSP address (see the table).
3. Click **Add camera**.
4. Open the camera and click **Test Connection**. A green result with the
   video size (for example 1920×1080) means it works.
5. Click **Live View** to watch it.

Your camera password is stored **encrypted** and is never shown again.

### 4.3 RTSP addresses by brand

The full address looks like `rtsp://USER:PASSWORD@IP:PORT/PATH`. In the form
you enter the pieces separately. Use the **Path** column for the Path field.

| Brand | Port | Path — main stream (best quality) | Path — sub stream (lower quality, less data) | Notes |
|---|---|---|---|---|
| **Hikvision** (and HiLook, Annke many models) | 554 | `/Streaming/Channels/101` | `/Streaming/Channels/102` | For NVR channel 2 use `201`/`202`, channel 3 `301`… |
| **Dahua** (and Amcrest, Lorex many models) | 554 | `/cam/realmonitor?channel=1&subtype=0` | `/cam/realmonitor?channel=1&subtype=1` | Change `channel=` for NVR channels. |
| **Reolink** | 554 | `/h264Preview_01_main` | `/h264Preview_01_sub` | 4K/H.265 models: `/h265Preview_01_main`. Enable RTSP in Reolink app → Settings → Network → Advanced → Port settings. |
| **Axis** | 554 | `/axis-media/media.amp` | `/axis-media/media.amp?resolution=640x480` | |
| **TP-Link Tapo** | 554 | `/stream1` | `/stream2` | In the Tapo app: Camera → Settings → Advanced → **Camera Account** — create a username/password. Use *that* account, not your TP-Link login. |
| **Uniview (UNV)** | 554 | `/unicast/c1/s0/live` | `/unicast/c1/s1/live` | Older firmware: `/media/video1`. |
| **Generic ONVIF camera** | 554 (RTSP), 80 or 8000 (ONVIF) | Choose **ONVIF**, set the ONVIF port, and use **Scan network**. If you know the RTSP path, enter it too. | | The camera's manual or the free "ONVIF Device Manager" tool shows the stream address. |
| **Other brands** | usually 554 | Search "<brand> <model> RTSP URL" | | Try it first in VLC: *Media → Open Network Stream*. If VLC plays it, this app can too. |

**Tip:** If VLC on your computer can play `rtsp://user:pass@IP:554/PATH`, the
same values will work here.

### 4.4 Same network vs. remote cameras

**Same network (self-hosted):** if the server running this app is in the same
building/network as the cameras, just use the camera's local IP
(`192.168.x.x` or `10.x.x.x`).

**Remote (cloud server, cameras at your home/shop):** the cloud server must be
able to reach the camera over the internet. Options, best first:

1. **VPN** (recommended): connect the camera network and the server with a VPN
   such as WireGuard or Tailscale, then use the camera's VPN address.
2. **Port forwarding:** on your router, forward an outside port (for example
   **5541**) to the camera's IP and port **554**. Then use your public IP or a
   free dynamic-DNS name (e.g. `myshop.ddns.net`) as **Host** and `5541` as
   **Port**. Use a **strong camera password** — the camera is now reachable
   from the internet. Forward one port per camera (5541, 5542, …).
3. Some ISPs block incoming connections (CGNAT). If port forwarding does not
   work, use a VPN.

For security, servers may block private/local addresses for cameras when
running as a shared cloud service. If you see "not allowed", use the public or
VPN address.

### 4.5 Troubleshooting

| Problem | What to try |
|---|---|
| **Test Connection: timeout** | Wrong IP or port; camera off; router not forwarding the port; firewall. Ping the camera, check the port. |
| **Test Connection: connection failed / 401** | Wrong username/password. For Tapo use the *Camera Account*. Some cameras lock after many wrong tries — wait 30 minutes. |
| **"404" / stream not found** | Wrong **Path**. Check the brand table, try the sub stream path. |
| **"Host is not allowed"** | You entered `localhost`, `127.0.0.1` or another blocked address. Use the camera's real IP. Do not type `rtsp://` in Host. |
| **Live View keeps "Connecting…"** | The camera may use H.265 (HEVC), which many browsers cannot play. Set the camera's main or sub stream to **H.264** in the camera settings, or use the sub stream path. |
| **Live View is a few seconds behind** | Normal — live video uses HLS, which adds 2–6 seconds of delay. |
| **Picture freezes** | Weak upload speed at the camera site. Use the sub stream path. |

---

## 5. Live View

1. Go to **Live View**.
2. Pick a layout: **1**, **2×2**, **3×3** or **4×4**.
3. Filter by **location** if you have many cameras. Use **Next/Previous** for
   more pages.
4. A red **LIVE** dot means the video is playing. Click a video for full screen.

You can also watch a single camera on its own page (Cameras → click the
camera). Cameras only connect while someone is watching (unless they are
recording), which saves data.

---

## 6. Recording and playback

**Start recording:** open the camera (Cameras → camera name) and click
**Start Recording**. Video is saved in short pieces (segments) to cloud
storage. Click **Stop Recording** to stop.

**Watch recordings:**
1. Go to **Recordings**.
2. Choose the **camera** and a **date** (only days with recordings are shown).
3. Click a bar on the timeline or **Play** on a segment. Use **Previous/Next**
   to move through the day.
4. Click **Download** to save a clip as an MP4 file.

Playback links expire after a few minutes for security; just click Play again.

---

## 7. Alerts

The **Alerts** page (with a number badge in the menu) shows problems such as:
camera offline, recording stopped, storage almost full, upload failed.

- Click **Mark read** or **Mark all as read**.
- Choose which alert types you want to see in **Settings → Alert preferences**.
- To get alerts in other apps (Slack, email via Zapier, etc.), add a
  **webhook** under **Integrations** (see section 10).

---

## 7A. Motion detection alerts

Each camera can watch for movement and alert you.

1. Open **Cameras** → click the camera → **Motion detection**.
2. Click **Turn on** (needs the Owner, Admin or Operator role).
3. Move the **Sensitivity** slider (1–100) and click **Save sensitivity**.
   - Start around **50–60**. If you get alerts from trees, rain or light
     changes, lower it. If people walking past are missed, raise it.
4. Detections appear in **Recent detections** on the camera page and in
   **Alerts → Recent motion detections**. A **"Motion detected"** alert is
   raised at most once every few minutes per camera (default 5), so a busy
   scene doesn't flood you.
5. Motion alerts follow your **Settings → Alert preferences** (you can mute
   "Motion detected") and are sent to any **webhook** subscribed to
   `MOTION_DETECTED` (section 10).

How it works: every ~20 seconds the server looks at a few seconds of the
camera's video at low resolution and measures how much the picture changes.
This doesn't need any motion feature on the camera itself, and it works for
any camera that live view works for. It is pixel-change detection, not
person/vehicle recognition. If the camera can't be reached, the camera page
shows "Last check failed" with the reason.

---

## 7B. People and vehicle alerts

When motion is detected, the server takes a snapshot and checks it for
**people** and **vehicles** (car, bus, truck, motorcycle, bicycle) using a
small AI model that runs on the server's CPU. Nothing is sent to an outside
AI service.

On the camera page, under **Motion detection → Alert me about**, tick:

- **People**: alert only when a person is seen.
- **Vehicles**: alert only when a vehicle is seen.
- **Any motion**: alert on every movement, labelled "Person detected" or
  "Vehicle detected" when one was seen.

Every detection is listed with its labels (for example "person 97%") and a
**snapshot thumbnail**. Click the thumbnail to open the full image. Alerts
show the thumbnail too. "Person detected" and "Vehicle detected" are
separate alert types, so you can mute them separately in **Settings → Alert
preferences**.

If the AI model isn't available on the server, you still get plain
**"Motion detected"** alerts, even if only People is ticked, so nothing is
silently missed. The detector can miss people who are very small, far away,
or in the dark.

### Zones, schedules and confidence

On the camera page, under **Detection zones** (operators and above):

1. A fresh snapshot from the camera is shown. Click around the area you
   care about, such as the driveway or the doorstep, then click **Finish zone**.
   You can draw up to 8 zones and rename them. **Remove** deletes one.
2. Only movement inside a zone triggers motion, and a person or vehicle only
   counts if the bottom of it (where they stand) is inside a zone. Cars
   passing on the street outside your zone are ignored.
3. **Alert schedule**: tick *Only alert during these times* and add time
   windows, for example Mon–Fri 22:00–06:00. A window that ends earlier than
   it starts runs overnight. Times use the **workspace timezone**, which you
   set in **Settings → Workspace timezone** (owners and admins). Outside the
   schedule, detections are still saved with snapshots, but no alert or push
   is sent.
4. **Confidence thresholds**: raise *Person* or *Vehicle* to cut false
   alarms, lower them to catch more.
5. Click **Save detection settings**.

The mobile app shows the zones on the camera page along with the schedule
and thresholds. Draw and edit zones in the web dashboard.

---

## 7C. Push notifications on your phone

*Using the mobile app?* Open **Settings → Push notifications → Enable** in
the app instead (needs Firebase set up by your administrator, see
[mobile-app.md](mobile-app.md)). The steps below are for the web dashboard.

1. Open the dashboard on your phone (on iPhone, first use Share → **Add to
   Home Screen** and open it from the home screen; iOS 16.4 or later).
2. Go to **Settings → Phone & browser notifications** and tap **Turn on for
   this device**. Allow notifications when asked.
3. Tap **Send test notification** to check that it works.

Each phone or browser shows up in the list. Tap **Remove** to stop alerts
to a device you no longer use. Push alerts follow your **Alert
preferences**: a muted alert type is not pushed either. Tapping a
notification opens the related camera or the Alerts page.

---

## 8. Storage and retention (how long video is kept)

### 8.1 Retention in days (Storage & retention page)

- **Keep recordings for (whole workspace)**: for example 30 days. Owners and
  admins can change it, up to your plan's limit.
- **Per camera**: type days in a camera's row to override the workspace
  setting (for example keep the front door for 60 days and the parking lot
  for 7). Leave it empty to use the workspace setting.
- Leave the workspace value empty to use the older per-camera retention
  *policies* (below).
- Older recordings are deleted from cloud storage and the database
  automatically, about once a minute. Shortening retention also removes
  existing older video, so double-check before saving.
- Motion snapshots follow the same number of days (30 days if nothing is
  set).
- The page shows total storage used, and storage and the oldest recording
  for each camera.

### 8.2 Retention policies

- **Storage** shows how much space each camera uses.
- Each camera has a **retention policy** — 7, 30 or 90 days. Older recordings
  are deleted automatically. Change it on the camera's page.
- Your plan limits the maximum retention and total storage. When storage is
  full, new recordings cannot start until old ones expire or you upgrade.

---

## 9. Subscription

Go to **Subscription** to see your plan, camera limit, storage used, and to
change or cancel your plan. New workspaces start with a free trial. Only the
Owner can cancel.

---

## 10. Integrations (webhooks)

A webhook sends every new alert to another service as a web request.

1. **Integrations → Add webhook**.
2. Enter a name and the URL from your other service (Zapier "Catch Hook",
   Make, n8n, or your own server). Choose which alert types to send, or leave
   all unchecked for all alerts.
3. Copy the **signing secret** shown once. Your server can use it to check the
   request really came from us (header `X-CCTV-Signature`).
4. Click **Send test** to check it works.

---

## 10A. Team: inviting people

Open **Team** in the menu.

**Roles**

| Role | Can do |
|---|---|
| Owner | Everything, including managing other owners |
| Admin | Cameras, locations, integrations, team (but not owners) |
| Operator | Add/edit cameras, recording, motion settings |
| Viewer | Watch live video and recordings only |

**Invite someone (Owner/Admin)**

1. Type their email, pick a role, click **Send invite**.
2. If the server has email set up, they get an email. If not, a link is
   shown **once** — click **Copy link** and send it to them yourself
   (WhatsApp, email, etc.).
3. The link expires after 72 hours. Sending a new invite to the same email
   cancels the old link.

**Accepting an invite**

- New to Universal CCTV: open the link, choose a password, click **Create
  account & join**.
- Already have an account: open the link, click **Sign in as …**, sign in
  with that same email, and click **Join workspace**.
- If you belong to more than one workspace, switch between them with the
  dropdown under "Universal CCTV" at the top of the menu.

**Managing the team**

- Change someone's role with the dropdown next to their name.
- **Remove** takes away their access immediately.
- **Revoke** cancels an invite that hasn't been accepted yet.
- A workspace always keeps at least one Owner.

---

## 10B. Using it on a phone

**Mobile app (Android and iOS).** Install the Universal CCTV app (your
administrator gives you the APK or a TestFlight / store link; see
[mobile-app.md](mobile-app.md)).

1. Enter your server address, e.g. `https://cctv.example.com/api`, and tap
   **Continue**. The app warns you if the address is plain `http://` over
   the internet.
2. Sign in with the same email and password as the dashboard.
3. Use the tabs at the bottom (on a tablet, on the left):
   - **Cameras**: cameras grouped by location with a **Recording / Idle**
     badge. Tap one for live view, status (**Test connection**),
     **Recordings**, and the **Motion & detection** switches (operators and
     admins only).
   - **Live**: a grid of live cameras. Pick 1, 4, 9 or 16 streams with the
     grid button.
   - **Alerts**: newest first, with person/vehicle labels and snapshots.
     Tap a detection to see the snapshot; **✓✓** marks everything read.
   - **Settings**: switch workspace, light/dark theme, **Enable** push
     notifications, **Sign out**.
4. The building icon at the top switches workspace.

Signing out ends the session on the server and stops push alerts to that
phone. You can also see the phone under **Settings → Signed-in devices** on
the dashboard (marked 📱); **Sign out other devices** there signs the phone
out too.

**Phone browser.** The dashboard also works in a phone browser. Tap **☰ Menu** at the top left to
open the menu. Live View shows one camera per row on a phone; pick **4×4**
for a compact 2-column grid. Wide tables scroll sideways.

---

## 11. Settings

- **Profile:** set your display name.
- **Change password:** enter your current password and a new one. All your
  *other* devices are signed out automatically.
- **Alert preferences:** turn alert types on/off for yourself.
- **Signed-in devices:** see where you're signed in and **Sign out all other
  devices** if you lost a phone or used a shared computer.

---

## 12. Security tips

- Change every camera's default password.
- Prefer a VPN over port forwarding.
- Give staff the **Viewer** role if they only need to watch.
- Sign out on shared computers.
