import 'package:cctv_mobile/core/api_client.dart';
import 'package:cctv_mobile/core/models.dart';

final testMe = Me(
  user: const User(id: 'u1', email: 'owner@example.com', displayName: 'Owner'),
  tenants: const [Tenant(id: 't1', name: 'Acme HQ', role: 'OWNER'), Tenant(id: 't2', name: 'Branch', role: 'VIEWER')],
  activeTenantId: 't1',
);

const testToken = 'abababababababababababababababababababababababababababababababab';

/// In-memory API used by widget tests; records calls.
class FakeApi extends ApiClient {
  FakeApi({super.token, this.validPassword = 'secret'}) : super(baseUrl: 'https://cctv.test');

  final String validPassword;
  final calls = <String>[];
  MotionSettings motion = const MotionSettings(enabled: false, sensitivity: 50, alertClasses: ['any']);

  @override
  Future<bool> checkHealth() async => true;

  @override
  Future<LoginResult> login(String email, String password, {String? deviceName}) async {
    calls.add('login:$email');
    if (password != validPassword) throw ApiException(401, 'invalid_credentials');
    return LoginResult(testToken, testMe);
  }

  @override
  Future<void> logout() async => calls.add('logout');

  @override
  Future<Me> me() async {
    if (token == null) throw ApiException(401, 'unauthorized');
    return testMe;
  }

  @override
  Future<void> switchTenant(String tenantId) async => calls.add('switch:$tenantId');

  @override
  Future<List<Location>> locations() async => const [Location(id: 'l1', name: 'Front office', cameraCount: 1)];

  @override
  Future<List<Camera>> cameras() async => const [
        Camera(id: 'c1', name: 'Lobby', connectorType: 'GENERIC_RTSP', host: '10.0.0.5', locationId: 'l1', motionEnabled: true),
        Camera(id: 'c2', name: 'Parking', connectorType: 'ONVIF', host: '10.0.0.6'),
      ];

  @override
  Future<Camera> camera(String id) async => (await cameras()).firstWhere((c) => c.id == id);

  @override
  Future<RecordingStatus> recordingStatus(String id) async => RecordingStatus(active: id == 'c1');

  @override
  Future<String> startLive(String id) async => throw ApiException(503, 'live_unavailable', 'no stream in tests');

  @override
  Future<MotionSettings> motionSettings(String id) async => motion;

  @override
  Future<MotionSettings> updateMotionSettings(String id, MotionSettings s) async {
    calls.add('motion:${s.enabled}:${s.alertClasses.join(',')}');
    return motion = s;
  }

  @override
  Future<({List<AppNotification> items, int unread})> notifications() async => (
        items: [
          AppNotification(id: 'n1', type: 'PERSON_DETECTED', message: 'Person detected on Lobby', createdAt: DateTime(2026, 10, 22, 9), eventId: 'e1'),
          AppNotification(id: 'n2', type: 'CAMERA_OFFLINE', message: 'Parking went offline', createdAt: DateTime(2026, 10, 22, 8), readAt: DateTime(2026, 10, 22, 8, 5)),
        ],
        unread: 1,
      );

  @override
  Future<List<MotionEvent>> motionEvents({int limit = 100, String? cameraId}) async => [
        MotionEvent(id: 'e1', cameraId: 'c1', cameraName: 'Lobby', detectedAt: DateTime(2026, 10, 22, 9), labels: const [
          DetectionLabel(label: 'person', category: 'person', score: 0.91),
          DetectionLabel(label: 'person', category: 'person', score: 0.62),
          DetectionLabel(label: 'car', category: 'vehicle', score: 0.55),
        ]),
      ];
}
