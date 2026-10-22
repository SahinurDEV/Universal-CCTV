# Local testing guide

Exact commands to run the whole platform on one Linux/macOS machine and test
it end to end **without a real camera** (a "fake camera" made with ffmpeg).

Two ways to run the backing services:

- **A. Docker** (easiest if you have Docker): `docker compose up -d`.
- **B. No Docker** (native installs + `scripts/local-services.sh`). This is the
  setup that was used to verify this branch.

---

## 0. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20+ | `node -v` |
| pnpm | 9+ (`corepack enable`) | `pnpm -v` |
| ffmpeg + ffprobe | any recent | `ffmpeg -version` |
| Docker *(option A)* | 24+ | `docker compose version` |
| PostgreSQL 14+, Redis 6+, MediaMTX 1.21.x, Python 3 *(option B)* | | see below |

## 1. Get the code and install

```bash
git clone https://github.com/SahinurDEV/Universal-CCTV.git
cd Universal-CCTV
pnpm install                # also runs `prisma generate`
cp .env.example apps/api/.env
# Generate the two secrets and paste them into apps/api/.env:
openssl rand -hex 32        # -> APP_SECRET
openssl rand -hex 32        # -> CREDENTIAL_ENCRYPTION_KEY
```

## 2A. Start services with Docker

```bash
docker compose up -d        # postgres :5433, redis, S3 (LocalStack) :4566, MediaMTX, fake camera
```

`apps/api/.env` from `.env.example` already matches (`DATABASE_URL` uses port 5433).

## 2B. Start services without Docker (Debian/Ubuntu example)

```bash
# PostgreSQL + Redis
sudo apt-get install -y postgresql redis-server
sudo service postgresql start && sudo service redis-server start
sudo -u postgres psql -c "CREATE USER cctv WITH PASSWORD 'cctv_dev_password' CREATEDB;" \
                      -c "CREATE DATABASE cctv OWNER cctv;"

# MediaMTX (media server)
curl -L https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_linux_amd64.tar.gz \
  | tar xz mediamtx && sudo mv mediamtx /usr/local/bin/

# Local S3-compatible storage (moto) — stands in for AWS S3 / LocalStack
python3 -m venv /opt/moto-venv && /opt/moto-venv/bin/pip install "moto[server]"
```

Edit `apps/api/.env`:

```bash
DATABASE_URL=postgresql://cctv:cctv_dev_password@localhost:5432/cctv   # native Postgres is on 5432
MEDIAMTX_RECORD_DIR=/ABSOLUTE/PATH/TO/Universal-CCTV/.local-run/recordings
```

Then start S3 + MediaMTX + the fake camera:

```bash
scripts/local-services.sh          # stop later with: scripts/local-services.sh stop
```

Logs are in `.local-run/*.log`.

## 3. The fake camera

Both options publish an ffmpeg test pattern (colour bars + clock + 440 Hz
tone) to **`rtsp://localhost:8554/simulated`**. Check it:

```bash
ffprobe -v error -rtsp_transport tcp -show_streams rtsp://localhost:8554/simulated | grep codec_name
# codec_name=h264 / codec_name=aac
```

Start one by hand (e.g. a second "camera") with:

```bash
ffmpeg -re -f lavfi -i "testsrc=size=1280x720:rate=15" -f lavfi -i "sine=frequency=440" \
  -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -c:a aac \
  -f rtsp rtsp://localhost:8554/simulated2
```

In the app, add it as connector type **SIMULATED**, host **localhost**, port
**8554**, path **/simulated** (or `/simulated2`). Simulated cameras are a
dev-only fixture (disabled when `NODE_ENV=production` unless
`ALLOW_SIMULATED_CAMERAS=true`).

## 4. Database setup

```bash
pnpm --filter @cctv/api exec prisma migrate deploy
pnpm --filter @cctv/api prisma:seed           # subscription plans
```

## 5. Run the apps (3 terminals)

```bash
pnpm dev:api                                   # API  -> http://localhost:4100
pnpm --filter @cctv/api worker                 # background worker (uploads recordings, alerts, retention)
pnpm dev:web                                   # Web  -> http://localhost:3100
```

Check: `curl http://localhost:4100/ready` → `{"status":"ok","checks":{"database":"ok","redis":"ok"}}`

## 6. Automated checks

```bash
pnpm -r build                                  # typecheck + build all packages
pnpm lint                                      # ESLint (api + web), zero warnings allowed
pnpm --filter @cctv/api test                   # unit tests (no services needed)
pnpm --filter @cctv/api test:integration       # integration tests (services from step 2 + fake camera must be running)
pnpm audit                                     # dependency audit
```

## 7. Manual end-to-end test in the browser

1. Open http://localhost:3100 → **Create a workspace**.
2. **Locations → Add location** "Head office".
3. **Cameras → Add camera**: Name "Front door", Location "Head office",
   Connector **SIMULATED**, Host `localhost`, Port `8554`, Path `/simulated`.
4. Open the camera → **Test Connection** → expect *Fully supported*, h264 1280×720 + aac.
   The live preview on that page starts playing colour bars.
5. **Live View** → choose 2×2 → the tile shows the test pattern with a red **LIVE** dot.
6. Back on the camera → **Start Recording**. Wait ~1–2 minutes (segments are
   60 s by default; the worker uploads every 15 s) → **Stop Recording**.
7. **Recordings** → pick the camera and today → click **Play** → the clip plays; **Download** saves an MP4.
8. **Storage** shows bytes used; **Settings** → change password / alert preferences;
   **Integrations** → add a webhook (e.g. a https://webhook.site URL) → **Send test**.

## 8. Same flow from the command line (API smoke test)

```bash
A=http://localhost:4100; J="-s -b /tmp/cj -c /tmp/cj -H Content-Type:application/json -H Origin:http://localhost:3100"
curl $J -X POST $A/auth/register -d '{"email":"me@example.com","password":"a-long-password","tenantName":"Test Co"}'
CAM=$(curl $J -X POST $A/cameras -d '{"name":"Fake","connectorType":"SIMULATED","host":"localhost","port":8554,"credential":{"path":"/simulated"}}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl $J -X POST $A/cameras/$CAM/test-connection
curl $J -X POST $A/cameras/$CAM/live/start
curl $J $A/cameras/$CAM/live/hls/index.m3u8                     # #EXTM3U playlist
curl $J -X POST $A/cameras/$CAM/recording/start -d '{"segmentSeconds":10}'
sleep 40
curl $J -X POST $A/cameras/$CAM/recording/stop                  # {"ingested":N,...}
curl $J "$A/cameras/$CAM/recordings?date=$(date -u +%F)"
```

## 9. Testing with a real camera on your LAN

Add it as **RTSP** with its LAN IP, port 554, username/password and the
brand path from docs/user-manual.md §4.3. `localhost`/`127.0.0.1` are always
rejected for non-simulated cameras (SSRF protection).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/ready` shows database error | Postgres not running or wrong port in `DATABASE_URL` (5433 Docker / 5432 native). |
| Recording starts but no segments | `MEDIAMTX_RECORD_DIR` must be writable by MediaMTX (Docker: leave default `/recordings`). |
| Integration tests fail on recording/live | The fake camera isn't publishing — check `.local-run/camera.log` or `docker compose logs simulated-camera`. |
| Live View "Connecting…" forever | API can't reach MediaMTX HLS on `MEDIAMTX_HLS_URL` (default `http://localhost:8888`). |
| Login works but dashboard calls fail with 403 `forbidden_origin` | Set `CORS_ORIGIN` in `apps/api/.env` to the exact web URL (comma-separate several). |
