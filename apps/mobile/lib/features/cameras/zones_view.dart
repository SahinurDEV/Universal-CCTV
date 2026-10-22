import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models.dart';
import '../../core/providers.dart';

const zoneColors = [Color(0xFF22C55E), Color(0xFF3B82F6), Color(0xFFF59E0B), Color(0xFFEC4899), Color(0xFFA855F7), Color(0xFF14B8A6), Color(0xFFEF4444), Color(0xFFEAB308)];

/// Paints detection-zone polygons (normalised 0..1 points) over a frame.
class ZonesPainter extends CustomPainter {
  ZonesPainter(this.zones);
  final List<DetectionZone> zones;

  @override
  void paint(Canvas canvas, Size size) {
    for (var i = 0; i < zones.length; i++) {
      final z = zones[i];
      if (z.points.length < 3) continue;
      final path = Path()..moveTo(z.points.first.$1 * size.width, z.points.first.$2 * size.height);
      for (final p in z.points.skip(1)) {
        path.lineTo(p.$1 * size.width, p.$2 * size.height);
      }
      path.close();
      final c = zoneColors[i % zoneColors.length];
      canvas.drawPath(path, Paint()..color = c.withValues(alpha: 0.25));
      canvas.drawPath(path, Paint()
        ..color = c
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2);
    }
  }

  @override
  bool shouldRepaint(ZonesPainter old) => old.zones != zones;
}

/// Read-only view of a camera's zones, schedule and thresholds (zones are
/// edited in the web dashboard, where there is room to draw).
class DetectionSummary extends ConsumerWidget {
  const DetectionSummary({super.key, required this.cameraId});
  final String cameraId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cfg = ref.watch(detectionConfigProvider(cameraId));
    final api = ref.watch(apiProvider);
    return cfg.when(
      loading: () => const SizedBox.shrink(),
      error: (_, _) => const SizedBox.shrink(),
      data: (c) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Text('Zones & schedule', style: Theme.of(context).textTheme.titleMedium),
        ),
        if (c.zones.isEmpty)
          const ListTile(dense: true, leading: Icon(Icons.crop_free), title: Text('Whole frame (no zones)'))
        else ...[
          if (api != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: AspectRatio(
                aspectRatio: 16 / 9,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Stack(fit: StackFit.expand, children: [
                    ColoredBox(
                      color: Colors.black,
                      child: Image.network(
                        api.snapshotJpegUrl(cameraId),
                        headers: api.authHeaders,
                        fit: BoxFit.fill,
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      ),
                    ),
                    CustomPaint(key: const Key('zonesOverlay'), painter: ZonesPainter(c.zones)),
                  ]),
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Wrap(spacing: 6, runSpacing: 4, children: [
              for (var i = 0; i < c.zones.length; i++)
                Chip(
                  avatar: CircleAvatar(backgroundColor: zoneColors[i % zoneColors.length], radius: 6),
                  label: Text(c.zones[i].name),
                  visualDensity: VisualDensity.compact,
                ),
            ]),
          ),
        ],
        ListTile(
          dense: true,
          leading: Icon(c.alertsActiveNow ? Icons.notifications_active : Icons.notifications_paused),
          title: Text(c.scheduleEnabled ? 'Alerts on schedule (${c.timezone})' : 'Alerts always on'),
          subtitle: c.scheduleEnabled
              ? Text([...c.windows.map((w) => w.label), c.alertsActiveNow ? 'Active now' : 'Paused now'].join('\n'))
              : null,
        ),
        ListTile(
          dense: true,
          leading: const Icon(Icons.tune),
          title: Text('Confidence: people ${(c.thresholdFor('person') * 100).round()}%, vehicles ${(c.thresholdFor('vehicle') * 100).round()}%'),
          subtitle: c.modelName.isEmpty ? null : Text('Detector: ${c.modelName}. Edit zones in the web dashboard.'),
        ),
      ]),
    );
  }
}
