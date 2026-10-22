import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../live/live_player.dart';

class CameraDetailScreen extends ConsumerWidget {
  const CameraDetailScreen({super.key, required this.cameraId});
  final String cameraId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cam = ref.watch(cameraProvider(cameraId));
    return Scaffold(
      appBar: AppBar(title: Text(cam.value?.name ?? 'Camera')),
      body: AsyncView(
        value: cam,
        onRetry: () => ref.invalidate(cameraProvider(cameraId)),
        data: (c) {
          final player = AspectRatio(aspectRatio: 16 / 9, child: LivePlayer(cameraId: c.id, key: ValueKey('live-${c.id}')));
          final info = _CameraInfo(camera: c);
          if (context.isWide) {
            return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 3, child: Padding(padding: const EdgeInsets.all(16), child: player)),
              Expanded(flex: 2, child: ListView(children: [info])),
            ]);
          }
          return ListView(children: [player, info]);
        },
      ),
    );
  }
}

class _CameraInfo extends ConsumerStatefulWidget {
  const _CameraInfo({required this.camera});
  final Camera camera;

  @override
  ConsumerState<_CameraInfo> createState() => _CameraInfoState();
}

class _CameraInfoState extends ConsumerState<_CameraInfo> {
  MotionSettings? _motion;
  Object? _motionError;
  bool _saving = false;
  bool _testing = false;
  String? _connection;

  @override
  void initState() {
    super.initState();
    _loadMotion();
  }

  Future<void> _loadMotion() async {
    try {
      final m = await ref.read(apiProvider)!.motionSettings(widget.camera.id);
      if (mounted) setState(() => _motion = m);
    } catch (e) {
      if (mounted) setState(() => _motionError = e);
    }
  }

  Future<void> _save(MotionSettings next) async {
    final prev = _motion;
    setState(() {
      _motion = next;
      _saving = true;
    });
    try {
      final saved = await ref.read(apiProvider)!.updateMotionSettings(widget.camera.id, next);
      if (mounted) setState(() => _motion = saved);
      ref.invalidate(camerasProvider);
    } catch (e) {
      if (mounted) {
        setState(() => _motion = prev);
        showSnack(context, errorText(e));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _test() async {
    setState(() => _testing = true);
    try {
      final r = await ref.read(apiProvider)!.testConnection(widget.camera.id);
      setState(() => _connection = r.ok ? 'Online — stream reachable' : 'Offline${r.reason != null ? ': ${r.reason}' : ''}');
    } catch (e) {
      setState(() => _connection = errorText(e));
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  void _toggleClass(String cls, bool on) {
    final m = _motion!;
    var classes = m.alertClasses.where((c) => c != 'any').toList();
    if (cls == 'any') {
      classes = on ? ['any'] : ['person'];
    } else {
      on ? classes.add(cls) : classes.remove(cls);
      if (classes.isEmpty) classes = ['any'];
    }
    _save(m.copyWith(alertClasses: classes.toSet().toList()));
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.camera;
    final canOperate = ref.watch(sessionProvider).value?.me?.activeTenant?.canOperate ?? false;
    final rec = ref.watch(recordingStatusProvider(c.id));
    final m = _motion;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ListTile(
        title: const Text('Status'),
        subtitle: _connection != null ? Text(_connection!) : null,
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          RecordingChip(status: rec),
          IconButton(
            tooltip: 'Test connection',
            onPressed: _testing ? null : _test,
            icon: _testing ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.network_check),
          ),
        ]),
      ),
      ListTile(
        leading: const Icon(Icons.video_library_outlined),
        title: const Text('Recordings'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.push('/cameras/${c.id}/recordings'),
      ),
      const Divider(),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: Text('Motion & detection', style: Theme.of(context).textTheme.titleMedium),
      ),
      if (m == null && _motionError == null) const Padding(padding: EdgeInsets.all(16), child: LinearProgressIndicator()),
      if (_motionError != null) ListTile(title: Text(errorText(_motionError!))),
      if (m != null) ...[
        SwitchListTile(
          key: const Key('motionToggle'),
          title: const Text('Motion detection'),
          subtitle: Text(canOperate ? 'Alerts when movement is detected' : 'Only operators and admins can change this'),
          value: m.enabled,
          onChanged: canOperate && !_saving ? (v) => _save(m.copyWith(enabled: v)) : null,
        ),
        ListTile(
          title: Text('Sensitivity: ${m.sensitivity}'),
          subtitle: Slider(
            value: m.sensitivity.toDouble().clamp(1, 100),
            min: 1,
            max: 100,
            divisions: 99,
            onChanged: canOperate && m.enabled ? (v) => setState(() => _motion = m.copyWith(sensitivity: v.round())) : null,
            onChangeEnd: canOperate && m.enabled ? (v) => _save(m.copyWith(sensitivity: v.round())) : null,
          ),
        ),
        const Padding(padding: EdgeInsets.fromLTRB(16, 4, 16, 0), child: Text('Alert on')),
        for (final (cls, label) in const [('any', 'Any motion'), ('person', 'People'), ('vehicle', 'Vehicles')])
          CheckboxListTile(
            key: Key('class-$cls'),
            dense: true,
            title: Text(label),
            value: m.alertClasses.contains(cls),
            onChanged: canOperate && m.enabled && !_saving ? (v) => _toggleClass(cls, v ?? false) : null,
          ),
        if (m.lastError != null)
          ListTile(leading: const Icon(Icons.warning_amber), title: Text(m.lastError!, style: const TextStyle(fontSize: 13))),
      ],
      const SizedBox(height: 24),
    ]);
  }
}
