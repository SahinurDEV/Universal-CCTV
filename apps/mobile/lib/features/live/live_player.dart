import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:video_player/video_player.dart';

import '../../core/api_client.dart';
import '../../core/providers.dart';
import '../../core/widgets.dart';

/// Plays a camera's live HLS stream via the API proxy.
/// The bearer token is sent on every playlist/segment request through httpHeaders.
class LivePlayer extends ConsumerStatefulWidget {
  const LivePlayer({super.key, required this.cameraId, this.muted = true, this.compact = false});
  final String cameraId;
  final bool muted;
  final bool compact;

  @override
  ConsumerState<LivePlayer> createState() => _LivePlayerState();
}

class _LivePlayerState extends ConsumerState<LivePlayer> {
  VideoPlayerController? _ctrl;
  Object? _error;
  bool _starting = true;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    setState(() {
      _starting = true;
      _error = null;
    });
    final api = ref.read(apiProvider);
    if (api == null) return;
    if (kIsWeb) {
      // Browsers cannot attach the bearer header to HLS requests; live view
      // is supported in the Android / iOS apps (and the web dashboard).
      setState(() {
        _starting = false;
        _error = 'web';
      });
      return;
    }
    try {
      final url = await api.startLive(widget.cameraId);
      final ctrl = VideoPlayerController.networkUrl(
        Uri.parse(url),
        formatHint: VideoFormat.hls,
        httpHeaders: api.authHeaders,
        videoPlayerOptions: VideoPlayerOptions(mixWithOthers: true),
      );
      await ctrl.initialize().timeout(const Duration(seconds: 25));
      await ctrl.setVolume(widget.muted ? 0 : 1);
      await ctrl.play();
      if (!mounted) return await ctrl.dispose();
      final old = _ctrl;
      setState(() => _ctrl = ctrl);
      await old?.dispose();
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ctrl = _ctrl;
    Widget content;
    if (_error != null) {
      content = Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.videocam_off, color: Colors.white70),
          if (!widget.compact)
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text(_liveErrorText(_error!),
                  style: const TextStyle(color: Colors.white70), textAlign: TextAlign.center),
            ),
          IconButton(onPressed: _start, icon: const Icon(Icons.refresh, color: Colors.white), tooltip: 'Retry'),
        ]),
      );
    } else if (_starting || ctrl == null || !ctrl.value.isInitialized) {
      content = const Center(child: CircularProgressIndicator(color: Colors.white));
    } else {
      content = Center(child: AspectRatio(aspectRatio: ctrl.value.aspectRatio, child: VideoPlayer(ctrl)));
    }
    return ColoredBox(
      color: Colors.black,
      child: Stack(fit: StackFit.expand, children: [
        content,
        if (ctrl != null && _error == null)
          const Positioned(top: 8, left: 8, child: StatusChip(label: 'LIVE', color: Colors.redAccent)),
      ]),
    );
  }
}

String _liveErrorText(Object e) {
  if (e == 'web') return 'Live view is available in the Android and iOS apps.';
  if (e is TimeoutException) return 'Stream timed out';
  if (e is ApiException) return e.friendly;
  return 'Could not play the stream.';
}
