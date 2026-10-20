# Open-Source Foundation Assessment

This evaluates whether to build the Universal CCTV Cloud Platform on top of an
existing open-source NVR/CCTV project, as opposed to the from-scratch
Node/Next.js/Prisma build already underway (see docs/architecture.md). Findings
are based on direct inspection of each project's repository metadata, LICENSE
file, and README via the GitHub API and live fetches on 2026-10-20 — not on
memory of these projects, since licensing accuracy has real legal weight for a
commercial product.

## 1. Recommendation (summary)

**Do not adopt a single existing NVR project as the foundation.** Instead:

- Keep the custom multi-tenant control plane (auth, tenancy, billing, DB,
  dashboard) already scaffolded — no evaluated project provides this, and it's
  the part open source helps with least anyway.
- **Adopt MediaMTX (MIT license) as an embedded media-server component** for
  RTSP ingestion/proxying and live-view delivery (WebRTC/HLS), replacing a
  meaningful share of the hand-rolled ffmpeg-process-management work planned
  for the Video Ingestion Service. Zero licensing risk, mature, permissive.
  This is the one clear "reuse, don't rewrite" win among the five.
  Confirm this specific proposal fits before wiring it in (see §7).
- **Do not use Shinobi** as a foundation: both the GitLab repo in your prompt
  and its GitHub mirror ship the same custom, non-free "Shinobi Open Source
  Software License Agreement," which requires a paid commercial subscription
  for essentially any commercial/SaaS deployment. Building a commercial SaaS
  on it means paying Shinobi Systems per deployment indefinitely.
- **Do not use OpenNVR as a base to modify**, given its AGPL-3.0 license,
  unless the business is willing to either (a) open-source this platform's
  server-side code under AGPL, or (b) run OpenNVR strictly as an unmodified,
  arm's-length microservice and get that isolation pattern reviewed by
  counsel. This is a business decision, not a technical one — flagged for
  your call in §7, not decided here.
- **Do not use Frigate as the application foundation.** Its MIT license is
  clean, but its architecture (single-site, Home Assistant-coupled, local
  disk storage, GPU/TPU-oriented object detection, no multi-tenancy, no S3)
  doesn't fit a multi-tenant cloud SaaS without an invasive rewrite — which
  the instructions explicitly discourage ("do not replace working features
  simply to introduce a different technology"; the "working feature" here,
  single-site home NVR, isn't the feature we need). Worth revisiting later as
  an isolated optional motion/object-detection microservice (Phase 8+), not now.
- **Do not use Scrypted.** Its own `LICENSE.md` states licensing varies per
  subdirectory and some plugins carry GPL-encumbered dependencies — this
  requires a full dependency-by-dependency audit before any commercial use,
  which is out of scope to resolve right now and disqualifies it as a
  foundation under the "verify current license before adopting" rule.

## 2. Repository and license assessment

| Project | Verified license | Source | Commercial SaaS viability |
|---|---|---|---|
| **MediaMTX** (bluenviron/mediamtx) | MIT (GitHub API, confirmed) | github.com/bluenviron/mediamtx | **Clean.** No restriction. 20.4k stars, Go, actively maintained (pushed within last day). |
| **Frigate** (blakeblackshear/frigate) | MIT (GitHub API, confirmed) | github.com/blakeblackshear/frigate | **Clean license**, but architecturally mismatched (see §1). 36.7k stars, Python, active. |
| **OpenNVR** (open-nvr/open-nvr) | AGPL-3.0 (GitHub API, confirmed) | github.com/open-nvr/open-nvr | **Network-copyleft risk.** AGPL §13 requires offering corresponding source to users of any network service built on a *modified* copy, and (more broadly than GPL) is commonly read to apply to running the program as a network service at all. Using it unmodified as an isolated microservice is the standard mitigation pattern but should get a real legal review before being relied on. 167 stars, Python, active (pushed yesterday) but young. |
| **Shinobi** (Shinobi-Systems/Shinobi, GitLab; mirrored at ShinobiCCTV/Shinobi on GitHub) | Custom: "Shinobi Open Source Software License Agreement v1" — **not** OSI/FSF open source despite the name. Confirmed by fetching the actual LICENSE/COPYING text, not a secondary source. | gitlab.com/Shinobi-Systems/Shinobi; raw COPYING.md | **Paid license required** for commercial use, hosted deployments, 25+ monitors outside schools, or 150+ monitors (Enterprise tier). GitHub mirror is also stale (last push 2020). |
| **Scrypted** (koush/scrypted) | `NOASSERTION` at repo level; `LICENSE.md` explicitly says license "will vary throughout the repository... some plugins may have dependencies that require GPL compliance." | github.com/koush/scrypted/blob/main/LICENSE.md | **Unresolved without a per-dependency audit.** Not a blanket license; risk is undefined until audited. 6k stars, TypeScript, active. |

Caveat on secondary sources: a web search surfaced older blog posts claiming a
separate GPLv3+AGPLv3 "Shinobi CE" edition exists with unrestricted commercial
use. The primary-source LICENSE files actually fetched from both the GitLab
repo named in your prompt and its GitHub mirror are identical and are the
restrictive custom agreement, not GPL — primary source wins over blog posts.
If a genuinely GPL-licensed Shinobi CE repository exists elsewhere, it has not
been located and verified here, so treat the "do not use Shinobi" conclusion
as applying specifically to the repository you linked.

## 3. Requirements-to-components matrix

Mapped against the product requirements in docs/requirements.md (which already
incorporates your original master prompt's feature list):

| Requirement | Existing OSS functionality | Needs config only | Needs adapter/plugin | Needs new development | Not supportable for every camera |
|---|---|---|---|---|---|
| RTSP ingestion / relay | MediaMTX | — | — | — | — |
| ONVIF discovery/capabilities | — (MediaMTX has no ONVIF layer) | — | Node `onvif` library adapter (planned) | Capability-detection logic, support-tier derivation | Yes — not all cameras answer ONVIF correctly |
| Live view delivery (WebRTC/HLS/LL-HLS) | MediaMTX | Stream-key/path config | — | Dashboard player UI | — |
| Continuous recording + segmentation | MediaMTX can record to disk | Segment duration config | — | Upload-to-S3 step, segment metadata DB rows, gap detection | — |
| S3-compatible cloud storage | — (none of the 5 projects natively target S3) | — | AWS SDK v3 (already planned) | Upload retry, multipart, lifecycle, quota accounting | — |
| Multi-tenant accounts, RBAC, tenant isolation | — (none of the 5 projects are multi-tenant) | — | — | Full tenancy layer (already scaffolded, see docs/database-schema.md) | — |
| Subscription/billing | — | — | Billing-provider abstraction (already scaffolded) | Dev adapter + plan limit enforcement | — |
| PTZ control | — | — | ONVIF PTZ adapter | Capability-gated UI controls | Yes — PTZ hardware-dependent |
| Motion/object-detection events | Frigate (if isolated as a service later) | — | Frigate-as-microservice integration (Phase 8+, not now) | — | Yes — depends on compute budget/hardware |
| Manufacturer proprietary cloud cameras (e.g. Wi-Fi-only) | Scrypted has plugins for some (Ring, Nest, etc.) but license unresolved | — | Blocked pending license audit | — | Yes, explicitly out of scope until audited/authorized |

**Conflict identified:** your new prompt's Phase 5 ("Implement a small working
proof of concept using a real ONVIF/RTSP camera") assumes a selected
foundation provides most of the stack; the license assessment above means no
single foundation does that safely. The PoC in §6 below is scoped against
MediaMTX + the custom control plane, not against a forked all-in-one NVR.

## 4. Proposed architecture (delta from docs/architecture.md)

No change to the tenancy/API/DB layers already built. One addition:

```
Camera (RTSP/ONVIF)
  │
  ▼
MediaMTX (per-camera path, MIT, runs as its own container)
  │  ├── live: WebRTC/HLS out ──► Web dashboard (Live View)
  │  └── record: segment files on a local volume
  ▼
Recording Manager (our code, BullMQ)
  │  watches MediaMTX's segment output directory / its on-finish hook
  ▼
Upload to S3-compatible storage + RecordingSegment metadata row (as designed)
```

MediaMTX replaces "hand-roll an ffmpeg child-process supervisor with
reconnect/backoff logic" with a maintained, battle-tested component; our code
still owns everything MediaMTX doesn't do (tenancy, metadata, retention, S3,
billing, capability detection, UI). This is additive to the existing Prisma
schema — no `RecordingJob`/`RecordingSegment` model changes needed.

## 5. Implementation roadmap (delta)

The phase order in docs/requirements.md/architecture.md stands. One change:
Phase 5 ("Video Recording") now starts with "stand up MediaMTX in
docker-compose and point one path at the simulated camera stream" instead of
"hand-write ffmpeg process supervision," before building the upload/metadata
layer on top. This is net less new code, not a detour.

## 6. Initial proof-of-concept plan

Scoped to be achievable without physical camera hardware (per
docs/requirements.md's simulated-connector requirement) and to produce a real,
verifiable artifact:

1. Add a `mediamtx` service to docker-compose.yml.
2. Add a `test-camera` service: ffmpeg looping a sample video file into
   MediaMTX over RTSP, acting as the "simulated camera."
3. Confirm MediaMTX exposes that stream back out (RTSP read-back as the
   cheapest proof the pipeline works end-to-end) — verified with `ffprobe`
   against the published path, not just "container is up."
4. Configure MediaMTX's recording feature to segment that stream to disk;
   verify a real file lands on disk with playable video (`ffprobe` duration >
   0), not a 0-byte file.
5. Only after step 4 is verified: wire a small watcher that uploads completed
   segments to the LocalStack S3 bucket and writes a `RecordingSegment` row.
6. Report pass/fail per step — do not report "recording works" until step 4
   through 5 are both independently confirmed, per the project's own
   "definition of done" (docs/requirements.md §4).

This PoC does not require a real ONVIF/RTSP camera to prove the pipeline
shape; a real camera is the next step once a LAN-reachable one is available
(see docs/requirements.md §3, item 3-4), and is tracked as a separate,
explicitly-flagged "not yet tested against real hardware" item until then.

## 7. Decisions (confirmed 2026-10-20)

1. **OpenNVR / AGPL** — skipped entirely. Not used in any form.
2. **Shinobi commercial license** — ruled out. Not used in any form.
3. **MediaMTX adoption** — confirmed. Will be wired in as the media-server
   component of the Video Ingestion Service when Phase 5 (Video Recording)
   starts; the architecture in §4 stands.

## 8. Infrastructure cost and storage estimate

Using the formula from your original master prompt (and documented for reuse
in a future storage calculator, Phase 7):

```
GB/day (decimal) = bitrate_Mbps × 10.8
Total retained GB = GB/day × retention_days × camera_count
```

Worked example — a small customer: 10 cameras, 2 Mbps average bitrate
(1080p, H.264, stream-copy), continuous 24/7 recording, 30-day retention:

- GB/day per camera = 2 × 10.8 = 21.6 GB
- GB/day, 10 cameras = 216 GB/day
- Retained storage at 30 days = 216 × 30 = **6,480 GB (≈6.5 TB)**

Rough AWS S3 Standard monthly cost at that retained volume (us-east-1
list pricing order-of-magnitude, **not a quote** — verify current pricing
before committing to customer-facing numbers):
- Storage: ~6,480 GB × ~$0.023/GB ≈ **$149/month**, growing as retained
  volume grows toward steady-state (first 30 days ramp up, then roughly flat
  since old segments expire as new ones land).
- PUT requests (one per 60s segment × 10 cameras × 1440 min/day × 30 ≈
  432,000 requests/month) at ~$0.005/1,000 ≈ **$2.16/month**.
- Egress/playback transfer is the variable, customer-behavior-dependent cost
  and is not estimated here — it depends on how much historical footage
  gets watched/downloaded, not on retention alone.
- **This does not include compute (ingestion/transcoding workers), database,
  Redis, or bandwidth from cameras to the ingestion point** — those scale
  with camera count and are a separate line item once worker sizing is known
  (Phase 9).

This is illustrative, not a finished pricing model — docs/requirements.md §16
(storage calculator) is where the full, configurable version belongs once
built.
