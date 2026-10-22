#!/usr/bin/env bash
# Starts the backing services WITHOUT Docker (for machines where Docker is not
# available). Expects PostgreSQL and Redis already running as system services
# (see docs/local-testing.md). Starts:
#   - a local S3-compatible server (moto) on :4566
#   - MediaMTX on :8554 (RTSP) / :8889 (WebRTC) / :8888 (HLS) / :9997 / :9996
#   - a fake camera: ffmpeg publishing a test pattern to rtsp://localhost:8554/simulated
# Logs and PIDs go to ./.local-run/. Stop everything with: scripts/local-services.sh stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.local-run"
mkdir -p "$RUN" "$RUN/recordings"
MOTO="${MOTO_BIN:-/opt/moto-venv/bin/moto_server}"
BUCKET="${STORAGE_BUCKET:-cctv-recordings}"

stop() {
  for f in "$RUN"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  echo "stopped"
}
if [ "${1:-}" = "stop" ]; then stop; exit 0; fi

start() { # name, command...
  local name=$1; shift
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  nohup "$@" >"$RUN/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
  echo "started $name (pid $!)"
}

start s3 "$MOTO" -H 127.0.0.1 -p 4566
# MediaMTX writes recordings to /recordings/... (see mediamtx-client.ts); use
# MEDIAMTX_RECORD_DIR in apps/api/.env to point at $RUN/recordings instead.
start mediamtx mediamtx "$ROOT/infra/mediamtx/mediamtx.yml"
sleep 2
curl -s -X PUT "http://127.0.0.1:4566/$BUCKET" >/dev/null && echo "bucket $BUCKET ready"
start camera ffmpeg -nostdin -loglevel warning -re -f lavfi -i "testsrc=size=1280x720:rate=15" \
  -f lavfi -i "sine=frequency=440" -c:v libx264 -preset ultrafast -tune zerolatency -g 30 \
  -c:a aac -ar 44100 -f rtsp "rtsp://${CAMERA_PUBLISH_USER:-publisher}:${CAMERA_PUBLISH_PASS:-publisher}@127.0.0.1:8554/simulated"
echo "fake camera: rtsp://localhost:8554/simulated"
