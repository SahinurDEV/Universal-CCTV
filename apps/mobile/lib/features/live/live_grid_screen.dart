import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'live_player.dart';

/// Multi-camera live grid. Columns adapt to the screen width; the user can
/// cap the number of simultaneous streams to save bandwidth.
class LiveGridScreen extends ConsumerStatefulWidget {
  const LiveGridScreen({super.key});

  @override
  ConsumerState<LiveGridScreen> createState() => _LiveGridScreenState();
}

class _LiveGridScreenState extends ConsumerState<LiveGridScreen> {
  int _max = 4;

  @override
  Widget build(BuildContext context) {
    final cams = ref.watch(camerasProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Live view'), actions: [
        PopupMenuButton<int>(
          tooltip: 'Streams shown',
          icon: const Icon(Icons.view_module),
          initialValue: _max,
          onSelected: (v) => setState(() => _max = v),
          itemBuilder: (_) => [for (final n in const [1, 4, 9, 16]) PopupMenuItem(value: n, child: Text('$n streams'))],
        ),
      ]),
      body: AsyncView(
        value: cams,
        onRetry: () => ref.invalidate(camerasProvider),
        data: (all) {
          final cameras = all.take(_max).toList();
          if (cameras.isEmpty) return const EmptyView(icon: Icons.grid_off, message: 'No cameras in this workspace.');
          final cols = _max == 1 ? 1 : context.gridColumns(minTile: 300).clamp(1, _max >= 9 ? 4 : 2);
          return GridView.builder(
            padding: const EdgeInsets.all(8),
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: cols, childAspectRatio: 16 / 10, mainAxisSpacing: 8, crossAxisSpacing: 8),
            itemCount: cameras.length,
            itemBuilder: (context, i) {
              final c = cameras[i];
              return ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Stack(fit: StackFit.expand, children: [
                  LivePlayer(key: ValueKey('grid-${c.id}'), cameraId: c.id, compact: true),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: Material(
                      color: Colors.black54,
                      child: InkWell(
                        onTap: () => context.push('/cameras/${c.id}'),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          child: Row(children: [
                            Expanded(child: Text(c.name, style: const TextStyle(color: Colors.white), overflow: TextOverflow.ellipsis)),
                            const Icon(Icons.open_in_full, size: 16, color: Colors.white),
                          ]),
                        ),
                      ),
                    ),
                  ),
                ]),
              );
            },
          );
        },
      ),
    );
  }
}
