# Share links

Let someone without an account watch **one camera live** or **one recorded
clip** (start–end, max 1 hour) through a public link.

## Options

| Option | Values |
|---|---|
| What | Live view of one camera, or a clip of one camera (start/end) |
| Expiry | 5 minutes – 7 days (required) |
| Password | optional, 6–128 chars, stored as a bcrypt hash (same helper as account passwords) |
| Max views | optional, 1–1000; each successful open counts as one view |
| Revoke | any time; takes effect immediately, including for people already watching |

Create links from the camera page (web, **Share** panel) or the share icon on
the mobile camera screen. Operator, Admin and Owner can create links;
Operators can revoke their own, Admins/Owners any in the workspace. Viewers
can't create or list links.

## How it is secured

- **Token**: `sl_<32 random base64url chars>.<22-char HMAC tag>`. The HMAC key
  is derived from `APP_SECRET`, so forged or mistyped tokens are rejected
  without a database lookup. **Only SHA-256(token) is stored**; the link is
  shown once at creation and never listed again.
- **Opening** (`POST /public/share/:token/open`) checks signature → hash
  lookup → not revoked/expired → password → atomically increments
  `viewCount` only while `viewCount < maxViews` (no over-counting under
  concurrent opens). Unknown, expired, revoked and used-up links all return
  the same `404 link_unavailable`.
- On success the viewer gets a **view token**: HMAC-signed, bound to that one
  link, valid ≤ 15 minutes and never beyond the link's expiry. Every HLS
  playlist/segment or clip request re-checks the link row, so revoking or
  expiring a link stops playback at the next request.
- **Strict scope**: a LIVE view token only proxies HLS files (strict file name
  pattern) for the link's camera; a CLIP token only returns segments of the
  link's camera that overlap the shared range (with offsets so the player
  trims to the range). A LIVE token can't fetch clips and vice versa. No
  cookies are sent from the viewer page (`credentials: "omit"`).
- Clip videos are returned as short-lived presigned storage URLs
  (`SIGNED_URL_TTL_SECONDS`, default 5 min). Within that window a copied
  segment URL works on its own — the same trade-off as signed-in playback.
- **Rate limits**: 30 opens / 15 min per IP (slows password guessing),
  600 stream requests / min per IP, 60 link creations / hour per user.
- **Audit log**: `share.create`, `share.revoke`, `share.view` (with IP),
  `share.password_failed` (with IP).
- Responses carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex`.

## API

| Method | Path | Auth |
|---|---|---|
| POST | `/cameras/:id/shares` `{kind, clipStart?, clipEnd?, expiresInMinutes, password?, maxViews?, label?}` | Operator+ |
| GET | `/shares?cameraId=` | Operator+ |
| DELETE | `/shares/:id` | Operator+ (own) / Admin+ |
| POST | `/public/share/:token/open` `{password?}` | public |
| GET | `/public/share/v/:viewToken/hls/:file` | public (view token) |
| GET | `/public/share/v/:viewToken/clip` | public (view token) |

Viewer page: `/share/<token>` in the web app (no login).

## Limits

- A live link keeps the camera stream running in MediaMTX while someone
  watches, like a signed-in viewer.
- Clips play segment by segment in the browser (no server-side stitching or
  download of the whole clip).
- Mobile app: creating links (with copy-to-clipboard) is supported; links open
  in the phone's browser, not inside the app.
