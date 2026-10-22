// End-to-end smoke test of the app's ApiClient against a REAL running API.
// Skipped unless CCTV_API_URL is set, e.g.:
//   CCTV_API_URL=http://127.0.0.1:4100 flutter test integration_api
// It registers a throwaway account, so point it only at a dev server.
import 'dart:io';

import 'package:cctv_mobile/core/api_client.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final base = Platform.environment['CCTV_API_URL'];
  final skip = base == null ? 'CCTV_API_URL not set' : null;

  test('login → data → live HLS with bearer → logout revokes', () async {
    final email = 'mobile-smoke-${DateTime.now().millisecondsSinceEpoch}@example.com';
    const password = 'Mobile-smoke-pass-1234';
    final raw = Dio(BaseOptions(baseUrl: base!, validateStatus: (_) => true));
    final reg = await raw.post<dynamic>('/auth/register', data: {'email': email, 'password': password, 'tenantName': 'Mobile Smoke'});
    expect(reg.statusCode, 201, reason: '${reg.data}');

    final anon = ApiClient(baseUrl: base);
    await expectLater(anon.login(email, 'wrong-password-123'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'invalid_credentials')));

    final login = await anon.login(email, password, deviceName: 'Smoke test');
    expect(login.token, matches(RegExp(r'^[0-9a-f]{64}$')));
    expect(login.me.user.email, email);
    final api = ApiClient(baseUrl: base, token: login.token);
    final me = await api.me();
    expect(me.activeTenant?.name, 'Mobile Smoke');

    // Create a location + simulated camera through the API with the bearer token.
    final authed = Dio(BaseOptions(baseUrl: base, headers: api.authHeaders, validateStatus: (_) => true));
    final loc = await authed.post<dynamic>('/locations', data: {'name': 'Smoke site', 'timezone': 'UTC'});
    expect(loc.statusCode, 201, reason: '${loc.data}');
    final cam = await authed.post<dynamic>('/cameras', data: {
      'name': 'Smoke cam',
      'connectorType': 'SIMULATED',
      'host': 'localhost',
      'port': 8554,
      'locationId': loc.data['id'],
      'credential': {'path': '/simulated'},
    });
    expect(cam.statusCode, 201, reason: '${cam.data}');
    final camId = cam.data['id'] as String;

    expect((await api.locations()).single.name, 'Smoke site');
    expect((await api.cameras()).single.id, camId);
    expect((await api.recordingStatus(camId)).active, isFalse);
    expect((await api.testConnection(camId)).ok, isTrue);

    final motion = await api.motionSettings(camId);
    final updated = await api.updateMotionSettings(camId, motion.copyWith(enabled: true, alertClasses: ['person', 'vehicle']));
    expect(updated.enabled, isTrue);
    expect(updated.alertClasses, containsAll(['person', 'vehicle']));
    await api.updateMotionSettings(camId, updated.copyWith(enabled: false));

    expect((await api.notifications()).items, isA<List<dynamic>>());
    expect(await api.motionEvents(), isEmpty);
    expect(await api.recordingDates(camId), isEmpty);

    // Live view: the playlist is fetched with the same bearer header the video player sends.
    final playlist = await api.startLive(camId);
    expect(playlist, startsWith(base));
    var body = '';
    for (var i = 0; i < 20 && !body.contains('#EXTM3U'); i++) {
      final r = await authed.get<String>(playlist, options: Options(responseType: ResponseType.plain));
      body = r.statusCode == 200 ? (r.data ?? '') : '';
      if (!body.contains('#EXTM3U')) await Future<void>.delayed(const Duration(seconds: 1));
    }
    expect(body, contains('#EXTM3U'));
    final noAuth = await raw.get<dynamic>(playlist);
    expect(noAuth.statusCode, 401);

    // FCM endpoints (server has no Firebase credentials in dev → disabled).
    final fcm = await api.fcmEnabled();
    if (!fcm) {
      await expectLater(api.registerFcmToken('x' * 40, 'android'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 503)));
    }

    await authed.delete<dynamic>('/cameras/$camId');
    await api.logout();
    await expectLater(api.me(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 2)));
}
