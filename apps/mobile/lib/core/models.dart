/// Plain data models mirroring the API's JSON responses.
library;

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;

class User {
  const User({required this.id, required this.email, this.displayName});
  final String id;
  final String email;
  final String? displayName;

  factory User.fromJson(Map<String, dynamic> j) =>
      User(id: j['id'] as String, email: j['email'] as String, displayName: j['displayName'] as String?);
}

class Tenant {
  const Tenant({required this.id, required this.name, required this.role, this.suspended = false});
  final String id;
  final String name;
  final String role;
  final bool suspended;

  factory Tenant.fromJson(Map<String, dynamic> j) => Tenant(
        id: j['id'] as String,
        name: j['name'] as String,
        role: (j['role'] as String?) ?? 'VIEWER',
        suspended: (j['suspended'] as bool?) ?? false,
      );

  bool get canOperate => role == 'OWNER' || role == 'ADMIN' || role == 'OPERATOR';
}

class Me {
  const Me({required this.user, required this.tenants, this.activeTenantId});
  final User user;
  final List<Tenant> tenants;
  final String? activeTenantId;

  factory Me.fromJson(Map<String, dynamic> j) => Me(
        user: User.fromJson(j['user'] as Map<String, dynamic>),
        tenants: [for (final t in (j['tenants'] as List? ?? const [])) Tenant.fromJson(t as Map<String, dynamic>)],
        activeTenantId: j['activeTenantId'] as String?,
      );

  Tenant? get activeTenant {
    for (final t in tenants) {
      if (t.id == activeTenantId) return t;
    }
    return null;
  }

  Me copyWith({String? activeTenantId}) =>
      Me(user: user, tenants: tenants, activeTenantId: activeTenantId ?? this.activeTenantId);
}

class Location {
  const Location({required this.id, required this.name, this.address, this.cameraCount = 0});
  final String id;
  final String name;
  final String? address;
  final int cameraCount;

  factory Location.fromJson(Map<String, dynamic> j) => Location(
        id: j['id'] as String,
        name: j['name'] as String,
        address: j['address'] as String?,
        cameraCount: (j['cameraCount'] as num?)?.toInt() ?? 0,
      );
}

class Camera {
  const Camera({
    required this.id,
    required this.name,
    required this.connectorType,
    required this.host,
    this.manufacturer,
    this.model,
    this.locationId,
    this.motionEnabled = false,
    this.liveView = true,
    this.playback = true,
  });
  final String id;
  final String name;
  final String connectorType;
  final String host;
  final String? manufacturer;
  final String? model;
  final String? locationId;
  final bool motionEnabled;
  final bool liveView;
  final bool playback;

  factory Camera.fromJson(Map<String, dynamic> j) {
    final cap = j['capability'] as Map<String, dynamic>?;
    return Camera(
      id: j['id'] as String,
      name: j['name'] as String,
      connectorType: (j['connectorType'] as String?) ?? 'GENERIC_RTSP',
      host: (j['host'] as String?) ?? '',
      manufacturer: j['manufacturer'] as String?,
      model: j['model'] as String?,
      locationId: j['locationId'] as String?,
      motionEnabled: (j['motionEnabled'] as bool?) ?? false,
      liveView: (cap?['liveView'] as bool?) ?? true,
      playback: (cap?['playback'] as bool?) ?? true,
    );
  }
}

class RecordingStatus {
  const RecordingStatus({required this.active, this.status, this.startedAt, this.segmentCount = 0});
  final bool active;
  final String? status;
  final DateTime? startedAt;
  final int segmentCount;

  factory RecordingStatus.fromJson(Map<String, dynamic> j) => RecordingStatus(
        active: (j['active'] as bool?) ?? false,
        status: j['status'] as String?,
        startedAt: _date(j['startedAt']),
        segmentCount: (j['segmentCount'] as num?)?.toInt() ?? 0,
      );
}

class MotionSettings {
  const MotionSettings({required this.enabled, required this.sensitivity, required this.alertClasses, this.lastError});
  final bool enabled;
  final int sensitivity;
  final List<String> alertClasses;
  final String? lastError;

  factory MotionSettings.fromJson(Map<String, dynamic> j) => MotionSettings(
        enabled: (j['enabled'] as bool?) ?? false,
        sensitivity: (j['sensitivity'] as num?)?.toInt() ?? 50,
        alertClasses: [for (final c in (j['alertClasses'] as List? ?? const ['any'])) c as String],
        lastError: j['lastError'] as String?,
      );

  Map<String, dynamic> toJson() => {'enabled': enabled, 'sensitivity': sensitivity, 'alertClasses': alertClasses};

  MotionSettings copyWith({bool? enabled, int? sensitivity, List<String>? alertClasses}) => MotionSettings(
        enabled: enabled ?? this.enabled,
        sensitivity: sensitivity ?? this.sensitivity,
        alertClasses: alertClasses ?? this.alertClasses,
        lastError: lastError,
      );
}

class Segment {
  const Segment({required this.id, required this.startedAt, this.endedAt, this.durationSec});
  final String id;
  final DateTime startedAt;
  final DateTime? endedAt;
  final num? durationSec;

  factory Segment.fromJson(Map<String, dynamic> j) => Segment(
        id: j['id'] as String,
        startedAt: _date(j['startedAt']) ?? DateTime.now(),
        endedAt: _date(j['endedAt']),
        durationSec: j['durationSec'] as num?,
      );
}

class DetectionLabel {
  const DetectionLabel({required this.label, required this.category, required this.score});
  final String label;
  final String category;
  final double score;

  factory DetectionLabel.fromJson(Map<String, dynamic> j) => DetectionLabel(
        label: (j['label'] as String?) ?? '',
        category: (j['category'] as String?) ?? 'other',
        score: (j['score'] as num?)?.toDouble() ?? 0,
      );
}

class MotionEvent {
  const MotionEvent({
    required this.id,
    required this.cameraId,
    required this.cameraName,
    required this.detectedAt,
    this.labels = const [],
    this.hasSnapshot = false,
  });
  final String id;
  final String cameraId;
  final String cameraName;
  final DateTime detectedAt;
  final List<DetectionLabel> labels;
  final bool hasSnapshot;

  factory MotionEvent.fromJson(Map<String, dynamic> j) => MotionEvent(
        id: j['id'] as String,
        cameraId: j['cameraId'] as String,
        cameraName: (j['cameraName'] as String?) ?? '',
        detectedAt: _date(j['detectedAt']) ?? DateTime.now(),
        labels: [for (final l in (j['labels'] as List? ?? const [])) DetectionLabel.fromJson(l as Map<String, dynamic>)],
        hasSnapshot: (j['hasSnapshot'] as bool?) ?? false,
      );
}

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.message,
    required this.createdAt,
    this.targetId,
    this.eventId,
    this.readAt,
  });
  final String id;
  final String type;
  final String message;
  final DateTime createdAt;
  final String? targetId;
  final String? eventId;
  final DateTime? readAt;

  bool get isRead => readAt != null;

  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
        id: j['id'] as String,
        type: j['type'] as String,
        message: (j['message'] as String?) ?? '',
        createdAt: _date(j['createdAt']) ?? DateTime.now(),
        targetId: j['targetId'] as String?,
        eventId: j['eventId'] as String?,
        readAt: _date(j['readAt']),
      );
}

/// Human label for a notification type.
String notificationTypeLabel(String type) => switch (type) {
      'CAMERA_OFFLINE' => 'Camera offline',
      'RECORDING_STOPPED' => 'Recording stopped',
      'STORAGE_QUOTA_WARNING' => 'Storage warning',
      'UPLOAD_FAILURE' => 'Upload failure',
      'RETENTION_CLEANUP_FAILURE' => 'Retention cleanup failure',
      'MOTION_DETECTED' => 'Motion',
      'PERSON_DETECTED' => 'Person',
      'VEHICLE_DETECTED' => 'Vehicle',
      _ => type,
    };
