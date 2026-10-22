# Detection zones, alert schedules, thresholds and models

## Zones

Each camera can have up to 8 polygon zones, each with 3 to 20 points. Points are normalised to 0..1 of the frame, so zones survive resolution changes. They are stored in `cameras.detection_zones`. No zones means the whole frame counts.

- **Motion inside zones only.** The worker rasterises the zones into a 320×180 greyscale PGM mask (`lib/zones.ts → buildMaskPgm`). ffmpeg multiplies every sampled frame by the mask before computing the scene score:
  `[0:v]fps=4,scale=320:180,format=gray[v];[1:v]...[m];[v][m]blend=all_mode=multiply,select=...`.
  Movement outside the zones is black, so it contributes nothing. Scene scores are frame averages, so the masked score is divided by the zone coverage (minimum 2%). That way the same sensitivity behaves the same with or without zones.
- **Objects inside zones only.** Detections carry a normalised box. A detection counts when its **bottom-centre** (feet or wheels) is inside any zone. Detections without a box are dropped when zones exist. The stored event labels are the in-zone detections.
- The zone image comes from `GET /cameras/:id/snapshot.jpg`. It grabs a fresh frame through the MediaMTX relay, is open to any role in the workspace, is rate-limited (probe limiter, 20 per minute) and is never cached.

## Alert schedules

`cameras.alert_schedule = {enabled, windows: [{days: [0..6], start: "HH:MM", end: "HH:MM"}]}`. Days run 0 = Sunday to 6 = Saturday. `end <= start` is an overnight window that belongs to its start day. Times are evaluated with `Intl` in the **workspace timezone** (`tenants.timezone`, default UTC), which is set with `PUT /workspace/timezone` by OWNER or ADMIN.

Outside the schedule, the motion check still runs and the event (labels and snapshot) is recorded, but **no notification, webhook or push** is created. An enabled schedule with no windows means alerts are never sent.

## Per-class confidence thresholds

`cameras.detection_thresholds = {person?: 0.2..0.95, vehicle?: 0.2..0.95}`. Missing classes use `DETECTION_MIN_SCORE` (default 0.5). The detector is run down to the lowest threshold in use, and each class is then filtered by its own threshold.

## Detector models

`DETECTION_MODEL` selects one model for the whole server:

| id | Model | License | Input | CPU time / frame* | Size |
|---|---|---|---|---|---|
| `ssd-mobilenet-v1` (**default**) | SSD MobileNet v1, COCO ([ONNX Model Zoo](https://github.com/onnx/models/tree/main/validated/vision/object_detection_segmentation/ssd-mobilenetv1)) | Apache-2.0 | 300×300 uint8 | ~20 ms | 29 MB |
| `rtdetr-r18` (optional) | RT-DETR R18vd, COCO (weights [PekingU/rtdetr_r18vd](https://huggingface.co/PekingU/rtdetr_r18vd), Apache-2.0; ONNX export [onnx-community/rtdetr_r18vd](https://huggingface.co/onnx-community/rtdetr_r18vd)) | Apache-2.0 | 640×640 float | ~200 ms | 83 MB |

\*Measured on this dev box (CPU only).

License check: the upstream RT-DETR code ([lyuwenyu/RT-DETR](https://github.com/lyuwenyu/RT-DETR)) and the PekingU weights are Apache-2.0. The onnx-community repository is a format conversion of those weights and declares no other license. YOLO models from Ultralytics (AGPL-3.0) were deliberately **not** used.

On the sample photo (`bus.jpg`), RT-DETR finds 4 people and the bus with boxes, including a partly visible person at the edge. SSD finds fewer. RT-DETR is more accurate on small or distant objects and costs about 10× the CPU. Detection only runs after motion fires, so that is usually affordable for a handful of cameras.

To switch:
```bash
DETECTION_MODEL=rtdetr-r18
pnpm --filter @cctv/api model:download   # or let it auto-download (SHA-256 checked)
# restart the worker
```
Models are downloaded to `apps/api/models/` (git-ignored) and checksum-verified before use.

## API

- `GET /cameras/:id/detection`: zones, schedule, thresholds, `defaultThreshold`, `timezone`, `alertsActiveNow`, and `model {id, name, license, enabled}`. Any role.
- `PUT /cameras/:id/detection {zones?, schedule?: obj|null, thresholds?: obj|null}`: OWNER, ADMIN or OPERATOR. The schema is strict, zone names are checked for control characters and `<>`, zone ids must be unique, and every change is audit-logged as `camera.detection.update`.
- `GET /cameras/:id/snapshot.jpg`
- `GET /workspace`, `PUT /workspace/timezone {timezone}`

## UI

- **Web:** the camera page has a **Detection zones** panel. Click to add points, then *Finish zone*. The panel also holds the schedule windows and the threshold sliders. **Settings → Workspace timezone** sets the timezone.
- **Mobile:** the camera page shows the zone overlay on a fresh frame, the schedule (active or paused now) and the thresholds. Editing is web-only.

## Tests

- Unit: `lib/zones.test.ts` (point in polygon, anchor filtering, mask rasterisation and coverage, validation), `lib/schedule.test.ts` (timezones, overnight windows, end-exclusive, validation), and `lib/detector.test.ts` (RT-DETR parsing, SSD boxes, per-class thresholds).
- Integration: `routes/detection-zones.integration.test.ts` covers API validation and roles, timezone, the worker honouring zones, thresholds and schedules, the mask reaching the sampler, **real ffmpeg sampling through a mask on the fake camera**, and the **real RT-DETR model** on a photo (skipped when the model file is absent).

## Limits

- The motion mask uses a fixed 320×180 grid; very thin zones (under about 1% of the frame) are coarse.
- Zones assume a fixed camera view. If a PTZ camera moves, the zones won't follow.
- One detector per server, not per camera.
