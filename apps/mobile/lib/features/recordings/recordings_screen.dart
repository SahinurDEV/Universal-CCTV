import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:video_player/video_player.dart';

import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/widgets.dart';

String formatDuration(num? seconds) {
  if (seconds == null) return '';
  final s = seconds.round();
  final m = s ~/ 60;
  return m > 0 ? '${m}m ${s % 60}s' : '${s}s';
}

class RecordingsScreen extends ConsumerStatefulWidget {
  const RecordingsScreen({super.key, required this.cameraId});
  final String cameraId;

  @override
  ConsumerState<RecordingsScreen> createState() => _RecordingsScreenState();
}

class _RecordingsScreenState extends ConsumerState<RecordingsScreen> {
  String? _date;

  @override
  Widget build(BuildContext context) {
    final dates = ref.watch(recordingDatesProvider(widget.cameraId));
    final cam = ref.watch(cameraProvider(widget.cameraId)).value;
    return Scaffold(
      appBar: AppBar(title: Text(cam == null ? 'Recordings' : '${cam.name} · Recordings')),
      body: AsyncView(
        value: dates,
        onRetry: () => ref.invalidate(recordingDatesProvider(widget.cameraId)),
        data: (list) {
          if (list.isEmpty) return const EmptyView(icon: Icons.video_library_outlined, message: 'No recordings for this camera yet.');
          final date = _date ?? list.last;
          return Column(children: [
            SizedBox(
              height: 56,
              child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.all(8), children: [
                for (final d in list.reversed)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(label: Text(d), selected: d == date, onSelected: (_) => setState(() => _date = d)),
                  ),
              ]),
            ),
            Expanded(child: _Segments(cameraId: widget.cameraId, date: date)),
          ]);
        },
      ),
    );
  }
}

class _Segments extends ConsumerWidget {
  const _Segments({required this.cameraId, required this.date});
  final String cameraId;
  final String date;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final segs = ref.watch(segmentsProvider((cameraId: cameraId, date: date)));
    final fmt = DateFormat.Hms();
    return AsyncView(
      value: segs,
      onRetry: () => ref.invalidate(segmentsProvider((cameraId: cameraId, date: date))),
      data: (list) => list.isEmpty
          ? const EmptyView(icon: Icons.hourglass_empty, message: 'No segments on this day.')
          : ListView.builder(
              itemCount: list.length,
              itemBuilder: (context, i) {
                final s = list[list.length - 1 - i];
                return ListTile(
                  leading: const Icon(Icons.play_circle_outline),
                  title: Text(fmt.format(s.startedAt)),
                  subtitle: Text(formatDuration(s.durationSec)),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => SegmentPlayerScreen(cameraId: cameraId, segment: s),
                  )),
                );
              },
            ),
    );
  }
}

/// Plays one recorded MP4 segment from its short-lived signed URL.
class SegmentPlayerScreen extends ConsumerStatefulWidget {
  const SegmentPlayerScreen({super.key, required this.cameraId, required this.segment});
  final String cameraId;
  final Segment segment;

  @override
  ConsumerState<SegmentPlayerScreen> createState() => _SegmentPlayerScreenState();
}

class _SegmentPlayerScreenState extends ConsumerState<SegmentPlayerScreen> {
  VideoPlayerController? _ctrl;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final url = await ref.read(apiProvider)!.segmentUrl(widget.cameraId, widget.segment.id);
      final c = VideoPlayerController.networkUrl(Uri.parse(url));
      await c.initialize();
      await c.play();
      if (!mounted) return await c.dispose();
      c.addListener(() => mounted ? setState(() {}) : null);
      setState(() => _ctrl = c);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = _ctrl;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(title: Text(DateFormat.yMMMd().add_Hms().format(widget.segment.startedAt))),
      body: _error != null
          ? ErrorView(error: _error!)
          : c == null
              ? const Center(child: CircularProgressIndicator())
              : Column(children: [
                  Expanded(child: Center(child: AspectRatio(aspectRatio: c.value.aspectRatio, child: VideoPlayer(c)))),
                  VideoProgressIndicator(c, allowScrubbing: true),
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    IconButton(
                      color: Colors.white,
                      icon: const Icon(Icons.replay_10),
                      onPressed: () => c.seekTo(c.value.position - const Duration(seconds: 10)),
                    ),
                    IconButton(
                      color: Colors.white,
                      iconSize: 40,
                      icon: Icon(c.value.isPlaying ? Icons.pause_circle : Icons.play_circle),
                      onPressed: () => c.value.isPlaying ? c.pause() : c.play(),
                    ),
                    IconButton(
                      color: Colors.white,
                      icon: const Icon(Icons.forward_10),
                      onPressed: () => c.seekTo(c.value.position + const Duration(seconds: 10)),
                    ),
                  ]),
                  const SizedBox(height: 16),
                ]),
    );
  }
}
