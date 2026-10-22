import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';

/// Hold-to-move PTZ pad, zoom and presets. Hidden unless the camera reported
/// PTZ support; read-only notice for Viewers (the API enforces roles too).
class PtzControls extends ConsumerStatefulWidget {
  const PtzControls({super.key, required this.cameraId});
  final String cameraId;

  @override
  ConsumerState<PtzControls> createState() => _PtzControlsState();
}

class _PtzControlsState extends ConsumerState<PtzControls> {
  static const _speed = 0.5;
  Timer? _repeat;
  String? _error;

  @override
  void dispose() {
    _repeat?.cancel();
    super.dispose();
  }

  void _start(double x, double y, double zoom) {
    final api = ref.read(apiProvider);
    if (api == null) return;
    Future<void> send() => api.ptzMove(widget.cameraId, x: x, y: y, zoom: zoom).catchError((Object e) {
          if (mounted) setState(() => _error = 'Could not move camera');
        });
    send();
    _repeat?.cancel();
    // Re-send while held; the camera auto-stops (timeout) if the app dies.
    _repeat = Timer.periodic(const Duration(seconds: 1), (_) => send());
  }

  void _end() {
    if (_repeat == null) return;
    _repeat?.cancel();
    _repeat = null;
    ref.read(apiProvider)?.ptzStop(widget.cameraId).catchError((Object _) {});
  }

  Widget _btn(String key, IconData icon, double x, double y, [double zoom = 0]) => GestureDetector(
        key: Key(key),
        onTapDown: (_) => _start(x, y, zoom),
        onTapUp: (_) => _end(),
        onTapCancel: _end,
        onLongPressEnd: (_) => _end(),
        child: Container(
          margin: const EdgeInsets.all(2),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
          child: Icon(icon, size: 22),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final info = ref.watch(ptzProvider(widget.cameraId)).value;
    if (info == null || !info.supported) return const SizedBox.shrink();
    return Card(
      key: const Key('ptzControls'),
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Pan / tilt / zoom', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          if (!info.canControl)
            const Text('Only Operators, Admins and Owners can move this camera.')
          else ...[
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Column(children: [
                _btn('ptz-up', Icons.keyboard_arrow_up, 0, _speed),
                Row(children: [
                  _btn('ptz-left', Icons.keyboard_arrow_left, -_speed, 0),
                  const SizedBox(width: 46),
                  _btn('ptz-right', Icons.keyboard_arrow_right, _speed, 0),
                ]),
                _btn('ptz-down', Icons.keyboard_arrow_down, 0, -_speed),
              ]),
              if (info.zoom) ...[
                const SizedBox(width: 24),
                Column(children: [
                  _btn('ptz-zoom-in', Icons.zoom_in, 0, 0, _speed),
                  _btn('ptz-zoom-out', Icons.zoom_out, 0, 0, -_speed),
                ]),
              ],
            ]),
            if (info.presets.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                for (final p in info.presets)
                  ActionChip(
                    key: Key('preset-${p.token}'),
                    label: Text(p.name),
                    onPressed: () => ref.read(apiProvider)?.ptzGotoPreset(widget.cameraId, p.token),
                  ),
              ]),
            ],
          ],
          if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        ]),
      ),
    );
  }
}
