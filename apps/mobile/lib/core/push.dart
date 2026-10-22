import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'api_client.dart';

/// Firebase options come from --dart-define so no google-services.json /
/// GoogleService-Info.plist has to be committed. When they are absent the
/// app runs normally with native push disabled.
class FirebaseConfig {
  static const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const senderId = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
  static const androidAppId = String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
  static const iosAppId = String.fromEnvironment('FIREBASE_IOS_APP_ID');
  static const iosBundleId = String.fromEnvironment('FIREBASE_IOS_BUNDLE_ID');

  static bool get supportedPlatform => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  static FirebaseOptions? get options {
    if (!supportedPlatform || apiKey.isEmpty || projectId.isEmpty || senderId.isEmpty) return null;
    final appId = Platform.isIOS ? iosAppId : androidAppId;
    if (appId.isEmpty) return null;
    return FirebaseOptions(
      apiKey: apiKey,
      appId: appId,
      messagingSenderId: senderId,
      projectId: projectId,
      iosBundleId: iosBundleId.isEmpty ? null : iosBundleId,
    );
  }
}

enum PushStatus { notConfiguredInApp, disabledOnServer, permissionDenied, registered, error }

class PushService {
  static bool _initialized = false;
  static StreamSubscription<String>? _sub;

  static Future<bool> init() async {
    if (_initialized) return true;
    final opts = FirebaseConfig.options;
    if (opts == null) return false;
    try {
      await Firebase.initializeApp(options: opts);
      _initialized = true;
    } catch (e) {
      debugPrint('Firebase init failed: $e');
    }
    return _initialized;
  }

  /// Asks permission, fetches the FCM token and registers it for this session.
  static Future<PushStatus> register(ApiClient api, {String? deviceName}) async {
    if (!await init()) return PushStatus.notConfiguredInApp;
    try {
      if (!await api.fcmEnabled()) return PushStatus.disabledOnServer;
      final m = FirebaseMessaging.instance;
      final perm = await m.requestPermission();
      if (perm.authorizationStatus == AuthorizationStatus.denied) return PushStatus.permissionDenied;
      final platform = Platform.isIOS ? 'ios' : 'android';
      // register() is async; the token (and any later rotation) arrives on onRegistered.
      final first = m.onRegistered.first.timeout(const Duration(seconds: 30));
      _sub?.cancel();
      _sub = m.onRegistered.skip(1).listen((t) => api.registerFcmToken(t, platform, deviceName: deviceName).ignore());
      await m.register();
      final token = await first;
      await api.registerFcmToken(token, platform, deviceName: deviceName);
      return PushStatus.registered;
    } catch (e) {
      debugPrint('FCM registration failed: $e');
      return PushStatus.error;
    }
  }

  static Future<void> unregisterLocal() async {
    if (!_initialized) return;
    try {
      await _sub?.cancel();
      await FirebaseMessaging.instance.unregister();
    } catch (_) {}
  }
}

String pushStatusText(PushStatus s) => switch (s) {
      PushStatus.notConfiguredInApp => 'This build has no Firebase configuration (see docs/mobile-app.md).',
      PushStatus.disabledOnServer => 'Push notifications are not configured on the server.',
      PushStatus.permissionDenied => 'Notification permission denied. Enable it in system settings.',
      PushStatus.registered => 'Push notifications enabled on this device.',
      PushStatus.error => 'Could not enable push notifications.',
    };
