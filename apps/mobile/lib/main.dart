import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/push.dart';

@pragma('vm:entry-point')
Future<void> _onBackgroundMessage(RemoteMessage message) async {
  // Notification payloads are displayed by the OS; nothing else to do.
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (await PushService.init()) {
    FirebaseMessaging.onBackgroundMessage(_onBackgroundMessage);
  }
  runApp(const ProviderScope(child: CctvApp()));
}
