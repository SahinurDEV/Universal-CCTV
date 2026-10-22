import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../shell/home_shell.dart';

/// Cameras grouped by location, each with a recording-status chip.
class CamerasScreen extends ConsumerWidget {
  const CamerasScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cams = ref.watch(camerasProvider);
    final locs = ref.watch(locationsProvider);
    final me = ref.watch(sessionProvider).value?.me;
    Future<void> refresh() async {
      ref.invalidate(camerasProvider);
      ref.invalidate(locationsProvider);
      ref.invalidate(recordingStatusProvider);
      await ref.read(camerasProvider.future);
    }

    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Cameras'),
          if (me?.activeTenant != null) Text(me!.activeTenant!.name, style: Theme.of(context).textTheme.bodySmall),
        ]),
        actions: [if (!context.isWide) const WorkspaceButton()],
      ),
      body: AsyncView(
        value: cams,
        onRetry: refresh,
        data: (cameras) {
          if (cameras.isEmpty) {
            return RefreshIndicator(
              onRefresh: refresh,
              child: ListView(children: const [
                SizedBox(height: 120),
                EmptyView(icon: Icons.videocam_off_outlined, message: 'No cameras in this workspace yet.\nAdd cameras from the web dashboard.'),
              ]),
            );
          }
          final locations = locs.value ?? const <Location>[];
          final groups = <(String, List<Camera>)>[
            for (final l in locations) (l.name, cameras.where((c) => c.locationId == l.id).toList()),
            ('Unassigned', cameras.where((c) => c.locationId == null || !locations.any((l) => l.id == c.locationId)).toList()),
          ].where((g) => g.$2.isNotEmpty).toList();
          return RefreshIndicator(
            onRefresh: refresh,
            child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
              for (final g in groups) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                  child: Row(children: [
                    const Icon(Icons.place_outlined, size: 18),
                    const SizedBox(width: 6),
                    Text('${g.$1} (${g.$2.length})', style: Theme.of(context).textTheme.titleSmall),
                  ]),
                ),
                for (final c in g.$2) CameraTile(camera: c),
              ],
            ]),
          );
        },
      ),
    );
  }
}

class CameraTile extends ConsumerWidget {
  const CameraTile({super.key, required this.camera});
  final Camera camera;

  @override
  Widget build(BuildContext context, WidgetRef ref) => ListTile(
        key: Key('camera-${camera.id}'),
        leading: const CircleAvatar(child: Icon(Icons.videocam)),
        title: Text(camera.name),
        subtitle: Text([camera.manufacturer, camera.model, camera.host].whereType<String>().where((s) => s.isNotEmpty).join(' · ')),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          if (camera.motionEnabled) const Padding(padding: EdgeInsets.only(right: 6), child: Icon(Icons.directions_run, size: 18)),
          RecordingChip(status: ref.watch(recordingStatusProvider(camera.id))),
        ]),
        onTap: () => context.push('/cameras/${camera.id}'),
      );
}
