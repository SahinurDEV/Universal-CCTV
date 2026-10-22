import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/providers.dart';
import 'core/theme.dart';
import 'features/alerts/alerts_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/auth/server_screen.dart';
import 'features/cameras/camera_detail_screen.dart';
import 'features/cameras/cameras_screen.dart';
import 'features/live/live_grid_screen.dart';
import 'features/recordings/recordings_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/shell/home_shell.dart';

/// Re-runs router redirects whenever the session changes.
class _SessionListenable extends ChangeNotifier {
  _SessionListenable(Ref ref) {
    ref.listen(sessionProvider, (_, _) => notifyListeners());
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _SessionListenable(ref);
  ref.onDispose(refresh.dispose);
  return GoRouter(
    initialLocation: '/cameras',
    refreshListenable: refresh,
    redirect: (context, state) {
      final session = ref.read(sessionProvider);
      final loc = state.matchedLocation;
      if (session.isLoading && !session.hasValue) return loc == '/splash' ? null : '/splash';
      if (session.hasError) return '/error';
      final s = session.value!;
      if (!s.hasServer) return loc == '/server' ? null : '/server';
      if (s.token == null) return (loc == '/login' || loc == '/server') ? null : '/login';
      if (loc == '/login' || loc == '/splash' || loc == '/error') return '/cameras';
      if (loc == '/server' && s.isLoggedIn) return '/cameras';
      return null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const Scaffold(body: Center(child: CircularProgressIndicator()))),
      GoRoute(
        path: '/error',
        builder: (_, _) => StartupErrorScreen(error: ref.read(sessionProvider).error ?? 'error'),
      ),
      GoRoute(path: '/server', builder: (_, _) => const ServerScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      ShellRoute(
        builder: (context, state, child) => HomeShell(location: state.matchedLocation, child: child),
        routes: [
          GoRoute(path: '/cameras', pageBuilder: (_, _) => const NoTransitionPage(child: CamerasScreen())),
          GoRoute(path: '/live', pageBuilder: (_, _) => const NoTransitionPage(child: LiveGridScreen())),
          GoRoute(path: '/alerts', pageBuilder: (_, _) => const NoTransitionPage(child: AlertsScreen())),
          GoRoute(path: '/settings', pageBuilder: (_, _) => const NoTransitionPage(child: SettingsScreen())),
        ],
      ),
      GoRoute(
        path: '/cameras/:id',
        builder: (_, st) => CameraDetailScreen(cameraId: st.pathParameters['id']!),
        routes: [
          GoRoute(path: 'recordings', builder: (_, st) => RecordingsScreen(cameraId: st.pathParameters['id']!)),
        ],
      ),
    ],
  );
});

class CctvApp extends ConsumerWidget {
  const CctvApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
        title: 'Universal CCTV',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: ref.watch(themeModeProvider),
        routerConfig: ref.watch(routerProvider),
      );
}
