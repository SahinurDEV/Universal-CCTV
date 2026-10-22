import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'models.dart';
import 'storage.dart';

/// Overridden in tests with [MemoryAppStorage].
final storageProvider = Provider<AppStorage>((ref) => SecureAppStorage());

/// Overridable factory so tests can inject a fake [ApiClient].
typedef ApiClientFactory = ApiClient Function(String baseUrl, String? token, void Function() onUnauthorized);
final apiClientFactoryProvider = Provider<ApiClientFactory>(
  (ref) => (baseUrl, token, onUnauthorized) => ApiClient(baseUrl: baseUrl, token: token, onUnauthorized: onUnauthorized),
);

class SessionState {
  const SessionState({this.serverUrl, this.token, this.me});
  final String? serverUrl;
  final String? token;
  final Me? me;

  bool get hasServer => serverUrl != null;
  bool get isLoggedIn => token != null && me != null;
}

class SessionController extends AsyncNotifier<SessionState> {
  AppStorage get _storage => ref.read(storageProvider);

  @override
  Future<SessionState> build() async {
    final server = await _storage.read(StorageKeys.serverUrl);
    final token = await _storage.read(StorageKeys.token);
    if (server == null || token == null) return SessionState(serverUrl: server);
    try {
      final me = await _client(server, token).me();
      return SessionState(serverUrl: server, token: token, me: me);
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await _storage.write(StorageKeys.token, null);
        return SessionState(serverUrl: server);
      }
      // Offline: keep the token so the user is not logged out by a flaky network.
      return SessionState(serverUrl: server, token: token);
    }
  }

  ApiClient _client(String server, String? token) =>
      ref.read(apiClientFactoryProvider)(server, token, () => expire());

  SessionState get _current => state.value ?? const SessionState();

  Future<void> setServer(String url) async {
    await _storage.write(StorageKeys.serverUrl, url);
    await _storage.write(StorageKeys.token, null);
    state = AsyncData(SessionState(serverUrl: url));
  }

  Future<void> login(String email, String password, {String? deviceName}) async {
    final server = _current.serverUrl;
    if (server == null) throw StateError('No server configured');
    final result = await _client(server, null).login(email, password, deviceName: deviceName);
    await _storage.write(StorageKeys.token, result.token);
    state = AsyncData(SessionState(serverUrl: server, token: result.token, me: result.me));
  }

  Future<void> retry() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(build);
  }

  Future<void> switchTenant(String tenantId) async {
    final s = _current;
    if (!s.isLoggedIn) return;
    await _client(s.serverUrl!, s.token).switchTenant(tenantId);
    state = AsyncData(SessionState(serverUrl: s.serverUrl, token: s.token, me: s.me!.copyWith(activeTenantId: tenantId)));
  }

  /// Revokes the session server-side (best effort) and wipes the token.
  Future<void> logout() async {
    final s = _current;
    if (s.token != null && s.serverUrl != null) {
      try {
        await _client(s.serverUrl!, s.token).logout();
      } catch (_) {/* token is wiped locally regardless */}
    }
    await expire();
  }

  /// Called when the server rejects the token (expired / revoked).
  Future<void> expire() async {
    await _storage.write(StorageKeys.token, null);
    state = AsyncData(SessionState(serverUrl: _current.serverUrl));
  }
}

final sessionProvider = AsyncNotifierProvider<SessionController, SessionState>(SessionController.new);

/// Authenticated API client for the current session (null when logged out).
final apiProvider = Provider<ApiClient?>((ref) {
  final s = ref.watch(sessionProvider).value;
  if (s == null || s.serverUrl == null) return null;
  return ref.read(apiClientFactoryProvider)(s.serverUrl!, s.token, () => ref.read(sessionProvider.notifier).expire());
});

ApiClient requireApi(Ref ref) {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException(401, 'unauthorized');
  return api;
}

/// Changes whenever the active workspace changes, so data providers refetch.
final activeTenantProvider = Provider<String?>((ref) => ref.watch(sessionProvider).value?.me?.activeTenantId);

class ThemeModeController extends Notifier<ThemeMode> {
  @override
  ThemeMode build() {
    ref.read(storageProvider).read(StorageKeys.themeMode).then((v) {
      final m = ThemeMode.values.where((m) => m.name == v);
      if (m.isNotEmpty) state = m.first;
    });
    return ThemeMode.system;
  }

  Future<void> set(ThemeMode mode) async {
    state = mode;
    await ref.read(storageProvider).write(StorageKeys.themeMode, mode.name);
  }
}

final themeModeProvider = NotifierProvider<ThemeModeController, ThemeMode>(ThemeModeController.new);

// ---- Data providers -------------------------------------------------------

final locationsProvider = FutureProvider<List<Location>>((ref) {
  ref.watch(activeTenantProvider);
  return requireApi(ref).locations();
});

final camerasProvider = FutureProvider<List<Camera>>((ref) {
  ref.watch(activeTenantProvider);
  return requireApi(ref).cameras();
});

final cameraProvider = FutureProvider.family<Camera, String>((ref, id) => requireApi(ref).camera(id));

final recordingStatusProvider =
    FutureProvider.family<RecordingStatus, String>((ref, id) => requireApi(ref).recordingStatus(id));

final recordingDatesProvider = FutureProvider.family<List<String>, String>((ref, id) => requireApi(ref).recordingDates(id));

final segmentsProvider = FutureProvider.family<List<Segment>, ({String cameraId, String date})>(
  (ref, a) => requireApi(ref).recordings(a.cameraId, a.date),
);

class AlertsData {
  const AlertsData(this.notifications, this.unread, this.events);
  final List<AppNotification> notifications;
  final int unread;
  final Map<String, MotionEvent> events;
}

final alertsProvider = FutureProvider<AlertsData>((ref) async {
  ref.watch(activeTenantProvider);
  final api = requireApi(ref);
  final results = await Future.wait([api.notifications(), api.motionEvents(limit: 200)]);
  final n = results[0] as ({List<AppNotification> items, int unread});
  final events = results[1] as List<MotionEvent>;
  return AlertsData(n.items, n.unread, {for (final e in events) e.id: e});
});

final snapshotUrlProvider = FutureProvider.family<String, String>((ref, eventId) => requireApi(ref).snapshotUrl(eventId));

final detectionConfigProvider = FutureProvider.family<DetectionConfig, String>((ref, id) => requireApi(ref).detectionConfig(id));
