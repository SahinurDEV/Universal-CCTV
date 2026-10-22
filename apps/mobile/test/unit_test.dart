import 'package:cctv_mobile/core/api_client.dart';
import 'package:cctv_mobile/core/models.dart';
import 'package:cctv_mobile/core/server_url.dart';
import 'package:cctv_mobile/features/alerts/alerts_screen.dart';
import 'package:cctv_mobile/features/recordings/recordings_screen.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

/// Dio adapter that answers from a map and records request headers.
class _Adapter implements HttpClientAdapter {
  _Adapter(this.handler);
  final ResponseBody Function(RequestOptions) handler;
  final seen = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(RequestOptions o, Stream<List<int>>? body, Future<void>? cancel) async {
    seen.add(o);
    return handler(o);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(int status, String body) =>
    ResponseBody.fromString(body, status, headers: {Headers.contentTypeHeader: ['application/json']});

void main() {
  group('normalizeServerUrl', () {
    test('adds https and strips trailing slash', () {
      final r = normalizeServerUrl(' cctv.example.com/api/ ');
      expect(r.url, 'https://cctv.example.com/api');
      expect(r.insecure, isFalse);
    });
    test('flags plain http on public hosts only', () {
      expect(normalizeServerUrl('http://cctv.example.com').insecure, isTrue);
      expect(normalizeServerUrl('http://192.168.1.10:4000').insecure, isFalse);
      expect(normalizeServerUrl('http://localhost:4100').insecure, isFalse);
      expect(normalizeServerUrl('http://10.0.2.2:4100').insecure, isFalse);
    });
    test('rejects bad input', () {
      expect(normalizeServerUrl('').ok, isFalse);
      expect(normalizeServerUrl('ftp://x.com').ok, isFalse);
      expect(normalizeServerUrl('https://user:pw@x.com').ok, isFalse);
      expect(normalizeServerUrl('https://x.com/?a=1').ok, isFalse);
    });
  });

  group('models', () {
    test('Me parses tenants and active tenant', () {
      final me = Me.fromJson({
        'user': {'id': 'u', 'email': 'a@b.c', 'displayName': null},
        'tenants': [
          {'id': 't1', 'name': 'One', 'role': 'VIEWER'},
          {'id': 't2', 'name': 'Two', 'role': 'ADMIN'},
        ],
        'activeTenantId': 't2',
      });
      expect(me.activeTenant!.name, 'Two');
      expect(me.activeTenant!.canOperate, isTrue);
      expect(me.tenants.first.canOperate, isFalse);
    });
    test('Camera reads capability flags', () {
      final c = Camera.fromJson({
        'id': 'c', 'name': 'Cam', 'connectorType': 'ONVIF', 'host': 'h', 'motionEnabled': true,
        'capability': {'liveView': false, 'playback': true},
      });
      expect(c.liveView, isFalse);
      expect(c.motionEnabled, isTrue);
    });
    test('MotionEvent and labelSummary dedupe labels by best score', () {
      final e = MotionEvent.fromJson({
        'id': 'e', 'cameraId': 'c', 'cameraName': 'Cam', 'detectedAt': '2026-10-22T03:00:00Z', 'hasSnapshot': true,
        'labels': [
          {'label': 'person', 'category': 'person', 'score': 0.5},
          {'label': 'person', 'category': 'person', 'score': 0.9},
          {'label': 'truck', 'category': 'vehicle', 'score': 0.7},
        ],
      });
      expect(labelSummary(e), ['person 90%', 'truck 70%']);
      expect(labelSummary(null), isEmpty);
    });
    test('notification labels and durations', () {
      expect(notificationTypeLabel('VEHICLE_DETECTED'), 'Vehicle');
      expect(notificationTypeLabel('NEW_TYPE'), 'NEW_TYPE');
      expect(formatDuration(125), '2m 5s');
      expect(formatDuration(9.6), '10s');
    });
  });

  group('ApiClient', () {
    test('sends bearer token and parses cameras', () async {
      final adapter = _Adapter((o) => _json(200, '{"cameras":[{"id":"c1","name":"Lobby","host":"h"}]}'));
      final dio = Dio()..httpClientAdapter = adapter;
      final api = ApiClient(baseUrl: 'https://x.test', token: 'tok', dio: dio);
      final cams = await api.cameras();
      expect(cams.single.name, 'Lobby');
      expect(adapter.seen.single.headers['Authorization'], 'Bearer tok');
      expect(adapter.seen.single.uri.toString(), 'https://x.test/cameras');
    });

    test('login posts to the mobile endpoint without a token', () async {
      final adapter = _Adapter((o) => _json(200,
          '{"token":"t","tokenType":"Bearer","user":{"id":"u","email":"a@b.c"},"tenants":[],"activeTenantId":null}'));
      final api = ApiClient(baseUrl: 'https://x.test', dio: Dio()..httpClientAdapter = adapter);
      final r = await api.login('a@b.c', 'pw', deviceName: 'Pixel');
      expect(r.token, 't');
      expect(adapter.seen.single.path, '/auth/mobile/login');
      expect(adapter.seen.single.headers.containsKey('Authorization'), isFalse);
      expect(adapter.seen.single.data, {'email': 'a@b.c', 'password': 'pw', 'deviceName': 'Pixel'});
    });

    test('maps errors and fires onUnauthorized on 401', () async {
      var expired = 0;
      final api = ApiClient(
        baseUrl: 'https://x.test',
        token: 'tok',
        dio: Dio()..httpClientAdapter = _Adapter((o) => _json(401, '{"error":"unauthorized"}')),
        onUnauthorized: () => expired++,
      );
      await expectLater(api.me(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
      expect(expired, 1);
    });

    test('429 maps to a friendly rate-limit message', () async {
      final api = ApiClient(baseUrl: 'https://x.test', dio: Dio()..httpClientAdapter = _Adapter((o) => _json(429, '"slow down"')));
      try {
        await api.login('a@b.c', 'x');
        fail('should throw');
      } on ApiException catch (e) {
        expect(e.friendly, contains('Too many attempts'));
      }
    });

    test('startLive resolves the playlist against the base URL', () async {
      final api = ApiClient(
        baseUrl: 'https://x.test/api',
        token: 't',
        dio: Dio()..httpClientAdapter = _Adapter((o) => _json(200, '{"playlistUrl":"/cameras/c1/live/hls/index.m3u8"}')),
      );
      expect(await api.startLive('c1'), 'https://x.test/api/cameras/c1/live/hls/index.m3u8');
    });
  });
}
