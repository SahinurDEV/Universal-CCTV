# Mobile app (Flutter, Android + iOS)

The app lives in `apps/mobile`. It talks to the same API as the web
dashboard, signing in with a **bearer token** instead of the session cookie.

| Feature | Where |
|---|---|
| Server URL (validated, warns on plain http to a public host) | first launch, *Change server* on sign-in |
| Sign in / sign out, token in Keychain / Android Keystore | `lib/core/providers.dart`, `lib/core/storage.dart` |
| Workspace switcher | building icon in the app bar, *Settings → Workspace* |
| Locations + cameras with Recording/Idle status | *Cameras* tab |
| Camera detail: live view, test connection, recordings, motion & detection toggles | tap a camera |
| Live grid (1/4/9/16 streams) via the API's HLS proxy | *Live* tab |
| Recordings by day, MP4 playback with scrubbing | camera → *Recordings* |
| Alerts with person/vehicle labels and snapshots, mark read | *Alerts* tab |
| FCM push (optional) | *Settings → Push notifications* |
| Light / dark / system theme; rail navigation on tablets | *Settings → Appearance* |

Stack: Flutter 3.x, `flutter_riverpod` (state), `go_router` (navigation and
auth redirects), `dio`, `flutter_secure_storage`, `video_player` (ExoPlayer
on Android, AVPlayer on iOS), `firebase_core` + `firebase_messaging`.

## API side

- `POST /auth/mobile/login` `{email, password, deviceName?}` →
  `{token, tokenType: "Bearer", expiresAt, user, tenants, activeTenantId}`.
  Send `Authorization: Bearer <token>` on every request. Same rate limit,
  password check and audit log as the web login. Mobile tokens only work as
  a bearer header and web tokens only as the cookie (see
  [security.md](security.md#mobile-app-auth-and-fcm-featuremobile-app)).
- `POST /auth/logout` revokes the session and deletes its FCM tokens.
- Live view: `POST /cameras/:id/live/start` returns `playlistUrl`
  (`/cameras/:id/live/hls/index.m3u8`). The player fetches it and every
  segment with the bearer header (`VideoPlayerController.networkUrl(...,
  httpHeaders: ...)`).
- FCM: `GET /push/fcm/config` → `{enabled}`; `POST /push/fcm/tokens`
  `{token, platform: "android"|"ios", deviceName?}` (mobile sessions only;
  503 when FCM is not configured); `GET /push/fcm/tokens`;
  `DELETE /push/fcm/tokens/:id`.

## Setup (development)

1. Install Flutter (stable) — <https://docs.flutter.dev/get-started/install>.
   For Android: Android SDK (platform 35/36, build-tools 35) and JDK 17+.
   For iOS: a Mac with Xcode and CocoaPods.
2. ```bash
   cd apps/mobile
   flutter pub get
   flutter analyze
   flutter test
   ```
3. Start the API (see [local-testing.md](local-testing.md)).

## Running on a phone

- **Android emulator**: the host machine is `10.0.2.2`, so use
  `http://10.0.2.2:4100` as the server URL. `flutter run`.
- **Real Android phone**: enable *Developer options → USB debugging*,
  connect it, `flutter devices`, `flutter run`. Use the API machine's LAN
  address, e.g. `http://192.168.1.20:4100` (phone and computer on the same
  Wi-Fi; the API must listen on `0.0.0.0`). Or install the debug APK:
  `adb install build/app/outputs/flutter-apk/app-debug.apk`.
- **iPhone** (needs a Mac): `open ios/Runner.xcworkspace`, set your Team
  under *Signing & Capabilities*, then `flutter run`. iOS only allows plain
  http to local-network addresses (`NSAllowsLocalNetworking`); use https for
  anything else.
- In production put the API behind HTTPS (see [deployment.md](deployment.md))
  and enter e.g. `https://cctv.example.com/api`.

Android allows cleartext http so the app can reach a LAN server during
setup; the app warns before using http with a public host.

## Building releases

### Android APK / App Bundle

1. Create a signing key once (keep it safe, never commit it):
   ```bash
   keytool -genkey -v -keystore ~/cctv-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias cctv
   ```
2. Create `apps/mobile/android/key.properties` (git-ignored):
   ```
   storePassword=...
   keyPassword=...
   keyAlias=cctv
   storeFile=/home/you/cctv-release.jks
   ```
   and in `android/app/build.gradle.kts` add a `signingConfigs { create("release") { ... } }`
   block reading it, then point `buildTypes.release.signingConfig` at it
   (the template currently signs release with the debug key so
   `flutter run --release` works).
3. Build:
   ```bash
   flutter build apk --release        # build/app/outputs/flutter-apk/app-release.apk
   flutter build appbundle --release  # for Google Play
   ```
   Add the Firebase `--dart-define`s below if you want push.

### iOS IPA (macOS only)

```bash
cd apps/mobile
flutter build ipa --release   # build/ios/ipa/*.ipa, upload with Transporter / Xcode
```
Set the bundle id (`com.universalcctv.cctvMobile` by default) and signing
team in Xcode first. iOS builds cannot be produced on Linux.

## Firebase (push notifications) — optional

Push is off unless **both** the server and the app are configured. Without
it the app works normally; *Settings → Push notifications* explains why it
can't be enabled.

1. Create a project at <https://console.firebase.google.com>.
2. **Android app**: add an Android app with package
   `com.universalcctv.cctv_mobile`. Note the *App ID*
   (`1:...:android:...`), *Project ID*, *Web API key* and *Sender ID*
   (Project settings → General / Cloud Messaging). You do **not** need to
   add `google-services.json`; the app takes these values as build
   defines.
3. **iOS app**: add an iOS app with your bundle id; note its App ID. In
   Xcode enable *Push Notifications* and *Background Modes → Remote
   notifications*, and upload an APNs auth key in Firebase → Project
   settings → Cloud Messaging.
4. **Build the app with the config:**
   ```bash
   flutter build apk --release \
     --dart-define=FIREBASE_API_KEY=AIza... \
     --dart-define=FIREBASE_PROJECT_ID=my-cctv \
     --dart-define=FIREBASE_MESSAGING_SENDER_ID=1234567890 \
     --dart-define=FIREBASE_ANDROID_APP_ID=1:1234567890:android:abc \
     --dart-define=FIREBASE_IOS_APP_ID=1:1234567890:ios:def \
     --dart-define=FIREBASE_IOS_BUNDLE_ID=com.universalcctv.cctvMobile
   ```
   (Tip: keep them in a git-ignored `firebase.json` and use
   `--dart-define-from-file=firebase.json`.)
5. **Server:** Firebase → Project settings → Service accounts → *Generate
   new private key*. Then set one of these in the API `.env`:
   ```
   FCM_SERVICE_ACCOUNT_FILE=/etc/cctv/firebase-sa.json
   # or
   FCM_SERVICE_ACCOUNT_BASE64=$(base64 -w0 firebase-sa.json)
   ```
   Restart the API **and** the worker (the worker sends alerts). Keep the key
   secret.
6. In the app: *Settings → Push notifications → Enable*, allow
   notifications. Alerts then arrive as system notifications (Android
   channel `alerts`) and follow each user's alert preferences.

## Tests

- `flutter analyze` — clean.
- `flutter test` — unit tests (URL validation, models, API client with a
  fake HTTP adapter: bearer header, error mapping, 401 handling) and widget
  tests (server → login → cameras flow, failed login, session restore,
  logout wipes token and revokes server-side, alerts with labels and badge,
  motion/detection toggles, workspace switch, tablet rail + dark mode).
- `CCTV_API_URL=http://127.0.0.1:4100 flutter test integration_api` — runs
  the real `ApiClient` against a running dev API: registers a throwaway
  account, bearer login, locations/cameras, test-connection, motion
  settings, alerts, live start + authenticated HLS playlist fetch (and 401
  without the token), FCM disabled → 503, logout revokes the token. Point it
  only at a dev server.
- API side: `apps/api/src/routes/mobile.integration.test.ts` and
  `src/middleware/auth.test.ts`.

## Known limitations

- Live view is not available in the Flutter **web** build (browsers can't
  attach the bearer header to HLS requests); use the web dashboard there.
- No certificate pinning yet.
- Push taps open the app but do not yet deep-link to the specific alert.
