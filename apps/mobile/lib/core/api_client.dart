import 'package:dio/dio.dart';

import 'models.dart';

class ApiException implements Exception {
  ApiException(this.status, this.code, [this.message]);
  final int? status;
  final String code;
  final String? message;

  bool get isUnauthorized => status == 401;

  String get friendly => switch (code) {
        'invalid_credentials' => 'Incorrect email or password.',
        'rate_limited' || 'too_many_requests' => 'Too many attempts. Wait a moment and try again.',
        'forbidden' => 'You do not have permission to do that.',
        'not_found' => 'Not found.',
        'network' => 'Cannot reach the server. Check the address and your connection.',
        'fcm_disabled' => 'Push notifications are not configured on this server.',
        _ => message ?? 'Request failed ($code).',
      };

  @override
  String toString() => 'ApiException($status, $code)';
}

class LoginResult {
  LoginResult(this.token, this.me);
  final String token;
  final Me me;
}

/// Thin typed wrapper around the Universal CCTV REST API using bearer auth.
class ApiClient {
  ApiClient({required this.baseUrl, this.token, Dio? dio, this.onUnauthorized})
      : dio = dio ??
            Dio(BaseOptions(
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 30),
            )) {
    this.dio.options.baseUrl = baseUrl;
    this.dio.options.headers['Accept'] = 'application/json';
  }

  final String baseUrl;
  final String? token;
  final Dio dio;
  final void Function()? onUnauthorized;

  Map<String, String> get authHeaders => token == null ? const {} : {'Authorization': 'Bearer $token'};

  /// Absolute URL for an API-relative path (e.g. HLS playlist).
  String resolve(String path) => path.startsWith('http') ? path : '$baseUrl$path';

  Future<dynamic> _req(String method, String path, {Object? data, Map<String, dynamic>? query}) async {
    try {
      final res = await dio.request<dynamic>(
        path,
        data: data,
        queryParameters: query,
        options: Options(method: method, headers: authHeaders),
      );
      return res.data;
    } on DioException catch (e) {
      final r = e.response;
      if (r == null) throw ApiException(null, 'network', e.message);
      final body = r.data;
      final code = body is Map && body['error'] is String
          ? body['error'] as String
          : (r.statusCode == 429 ? 'rate_limited' : 'http_${r.statusCode}');
      final msg = body is Map && body['message'] is String ? body['message'] as String : null;
      if (r.statusCode == 401 && token != null) onUnauthorized?.call();
      throw ApiException(r.statusCode, code, msg);
    }
  }

  Future<Map<String, dynamic>> _json(String method, String path, {Object? data, Map<String, dynamic>? query}) async {
    final d = await _req(method, path, data: data, query: query);
    return d is Map<String, dynamic> ? d : <String, dynamic>{};
  }

  Future<bool> checkHealth() async {
    final d = await _req('GET', '/health');
    return d is Map;
  }

  Future<LoginResult> login(String email, String password, {String? deviceName}) async {
    final j = await _json('POST', '/auth/mobile/login', data: {
      'email': email,
      'password': password,
      if (deviceName != null && deviceName.isNotEmpty) 'deviceName': deviceName,
    });
    return LoginResult(j['token'] as String, Me.fromJson(j));
  }

  Future<void> logout() => _req('POST', '/auth/logout');

  Future<Me> me() async => Me.fromJson(await _json('GET', '/auth/me'));

  Future<void> switchTenant(String tenantId) => _req('POST', '/auth/switch-tenant', data: {'tenantId': tenantId});

  Future<List<Location>> locations() async =>
      [for (final l in (await _json('GET', '/locations'))['locations'] as List? ?? const []) Location.fromJson(l as Map<String, dynamic>)];

  Future<List<Camera>> cameras() async =>
      [for (final c in (await _json('GET', '/cameras'))['cameras'] as List? ?? const []) Camera.fromJson(c as Map<String, dynamic>)];

  Future<Camera> camera(String id) async => Camera.fromJson(await _json('GET', '/cameras/$id'));

  Future<RecordingStatus> recordingStatus(String id) async =>
      RecordingStatus.fromJson(await _json('GET', '/cameras/$id/recording'));

  Future<({bool ok, String? reason})> testConnection(String id) async {
    final j = await _json('POST', '/cameras/$id/test-connection');
    return (ok: (j['ok'] as bool?) ?? false, reason: j['reason'] as String?);
  }

  /// Starts (or reuses) the live HLS session; returns the absolute playlist URL.
  Future<String> startLive(String id) async {
    final j = await _json('POST', '/cameras/$id/live/start');
    return resolve(j['playlistUrl'] as String);
  }

  /// Creates a public share link; the URL (with token) is returned only once.
  Future<String> createShareLink(String cameraId,
      {required String kind, required int expiresInMinutes, DateTime? clipStart, DateTime? clipEnd, String? password, int? maxViews}) async {
    final j = await _json('POST', '/cameras/$cameraId/shares', data: {
      'kind': kind,
      'expiresInMinutes': expiresInMinutes,
      if (clipStart != null) 'clipStart': clipStart.toUtc().toIso8601String(),
      if (clipEnd != null) 'clipEnd': clipEnd.toUtc().toIso8601String(),
      if (password != null && password.isNotEmpty) 'password': password,
      'maxViews': ?maxViews,
    });
    return j['url'] as String;
  }

  Future<MotionSettings> motionSettings(String id) async =>
      MotionSettings.fromJson(await _json('GET', '/cameras/$id/motion'));

  Future<MotionSettings> updateMotionSettings(String id, MotionSettings s) async =>
      MotionSettings.fromJson(await _json('PUT', '/cameras/$id/motion', data: s.toJson()));

  Future<List<String>> recordingDates(String id) async =>
      [for (final d in (await _json('GET', '/cameras/$id/recordings/dates'))['dates'] as List? ?? const []) d as String];

  Future<List<Segment>> recordings(String id, String date) async => [
        for (final s in (await _json('GET', '/cameras/$id/recordings', query: {'date': date}))['segments'] as List? ?? const [])
          Segment.fromJson(s as Map<String, dynamic>)
      ];

  Future<String> segmentUrl(String cameraId, String segmentId) async =>
      (await _json('GET', '/cameras/$cameraId/recordings/$segmentId/url'))['url'] as String;

  Future<({List<AppNotification> items, int unread})> notifications() async {
    final j = await _json('GET', '/notifications');
    return (
      items: [for (final n in j['notifications'] as List? ?? const []) AppNotification.fromJson(n as Map<String, dynamic>)],
      unread: (j['unreadCount'] as num?)?.toInt() ?? 0,
    );
  }

  Future<void> markRead(String id) => _req('POST', '/notifications/$id/read');
  Future<void> markAllRead() => _req('POST', '/notifications/read-all');

  Future<List<MotionEvent>> motionEvents({int limit = 100, String? cameraId}) async => [
        for (final e in (await _json('GET', '/motion-events', query: {
          'limit': limit,
          'cameraId': ?cameraId,
        }))['events'] as List? ?? const [])
          MotionEvent.fromJson(e as Map<String, dynamic>)
      ];

  Future<String> snapshotUrl(String eventId) async =>
      (await _json('GET', '/motion-events/$eventId/snapshot'))['url'] as String;

  Future<bool> fcmEnabled() async => ((await _json('GET', '/push/fcm/config'))['enabled'] as bool?) ?? false;

  Future<void> registerFcmToken(String token, String platform, {String? deviceName}) => _req('POST', '/push/fcm/tokens', data: {
        'token': token,
        'platform': platform,
        'deviceName': ?deviceName,
      });
}
