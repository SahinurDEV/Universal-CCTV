import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/widgets.dart';

IconData alertIcon(String type) => switch (type) {
      'PERSON_DETECTED' => Icons.person,
      'VEHICLE_DETECTED' => Icons.directions_car,
      'MOTION_DETECTED' => Icons.directions_run,
      'CAMERA_OFFLINE' => Icons.videocam_off,
      'RECORDING_STOPPED' => Icons.stop_circle_outlined,
      'STORAGE_QUOTA_WARNING' => Icons.storage,
      _ => Icons.warning_amber,
    };

/// Distinct detection labels (e.g. "person 92%") for an event, best first.
List<String> labelSummary(MotionEvent? e) {
  if (e == null) return const [];
  final best = <String, double>{};
  for (final l in e.labels) {
    if (l.score > (best[l.label] ?? -1)) best[l.label] = l.score;
  }
  final entries = best.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
  return [for (final en in entries) '${en.key} ${(en.value * 100).round()}%'];
}

class AlertsScreen extends ConsumerWidget {
  const AlertsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final alerts = ref.watch(alertsProvider);
    Future<void> refresh() async {
      ref.invalidate(alertsProvider);
      await ref.read(alertsProvider.future);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Alerts'), actions: [
        IconButton(
          tooltip: 'Mark all read',
          icon: const Icon(Icons.done_all),
          onPressed: () async {
            try {
              await ref.read(apiProvider)!.markAllRead();
              ref.invalidate(alertsProvider);
            } catch (e) {
              if (context.mounted) showSnack(context, errorText(e));
            }
          },
        ),
      ]),
      body: AsyncView(
        value: alerts,
        onRetry: refresh,
        data: (d) => RefreshIndicator(
          onRefresh: refresh,
          child: d.notifications.isEmpty
              ? ListView(children: const [SizedBox(height: 120), EmptyView(icon: Icons.notifications_none, message: 'No alerts.')])
              : ListView.separated(
                  itemCount: d.notifications.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final n = d.notifications[i];
                    return AlertTile(notification: n, event: n.eventId == null ? null : d.events[n.eventId]);
                  },
                ),
        ),
      ),
    );
  }
}

class AlertTile extends ConsumerWidget {
  const AlertTile({super.key, required this.notification, this.event});
  final AppNotification notification;
  final MotionEvent? event;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final n = notification;
    final theme = Theme.of(context);
    final labels = labelSummary(event);
    return InkWell(
      onTap: () async {
        if (!n.isRead) {
          ref.read(apiProvider)?.markRead(n.id).then((_) => ref.invalidate(alertsProvider)).ignore();
        }
        final cameraId = event?.cameraId ?? n.targetId;
        if (event?.hasSnapshot == true) {
          await showDialog<void>(context: context, builder: (_) => SnapshotDialog(event: event!));
        } else if (cameraId != null && n.type != 'STORAGE_QUOTA_WARNING') {
          context.push('/cameras/$cameraId');
        }
      },
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (event?.hasSnapshot == true)
            SizedBox(width: 96, height: 60, child: ClipRRect(borderRadius: BorderRadius.circular(6), child: SnapshotImage(eventId: event!.id)))
          else
            SizedBox(width: 40, child: Icon(alertIcon(n.type), color: n.isRead ? theme.colorScheme.outline : theme.colorScheme.primary)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text(notificationTypeLabel(n.type),
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(fontWeight: n.isRead ? FontWeight.normal : FontWeight.bold)),
                ),
                Text(DateFormat.MMMd().add_Hm().format(n.createdAt), style: theme.textTheme.bodySmall),
              ]),
              const SizedBox(height: 2),
              Text(n.message, maxLines: 2, overflow: TextOverflow.ellipsis),
              if (labels.isNotEmpty) ...[
                const SizedBox(height: 4),
                Wrap(spacing: 4, runSpacing: 4, children: [
                  for (final l in labels.take(4))
                    Chip(label: Text(l), visualDensity: VisualDensity.compact, materialTapTargetSize: MaterialTapTargetSize.shrinkWrap),
                ]),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}

class SnapshotImage extends ConsumerWidget {
  const SnapshotImage({super.key, required this.eventId, this.fit = BoxFit.cover});
  final String eventId;
  final BoxFit fit;

  @override
  Widget build(BuildContext context, WidgetRef ref) => ref.watch(snapshotUrlProvider(eventId)).when(
        data: (url) => Image.network(url, fit: fit, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black26, child: Icon(Icons.broken_image))),
        loading: () => const ColoredBox(color: Colors.black12),
        error: (_, _) => const ColoredBox(color: Colors.black26, child: Icon(Icons.image_not_supported)),
      );
}

class SnapshotDialog extends StatelessWidget {
  const SnapshotDialog({super.key, required this.event});
  final MotionEvent event;

  @override
  Widget build(BuildContext context) => Dialog(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          AspectRatio(aspectRatio: 16 / 9, child: SnapshotImage(eventId: event.id, fit: BoxFit.contain)),
          ListTile(
            title: Text(event.cameraName),
            subtitle: Text('${DateFormat.yMMMd().add_Hms().format(event.detectedAt)}\n${labelSummary(event).join(', ')}'),
          ),
          OverflowBar(alignment: MainAxisAlignment.end, children: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close')),
            TextButton(
              onPressed: () {
                Navigator.pop(context);
                context.push('/cameras/${event.cameraId}');
              },
              child: const Text('Open camera'),
            ),
          ]),
        ]),
      );
}
