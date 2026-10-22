import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';

/// Renders an [AsyncValue] with consistent loading / error / retry UI.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({super.key, required this.value, required this.data, this.onRetry});
  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => value.when(
        data: data,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: onRetry),
      );
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.onRetry});
  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.error_outline, size: 40, color: Theme.of(context).colorScheme.error),
            const SizedBox(height: 12),
            Text(errorText(error), textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Retry')),
            ],
          ]),
        ),
      );
}

String errorText(Object e) => e is ApiException ? e.friendly : 'Something went wrong.';

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.icon, required this.message});
  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 48, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
          ]),
        ),
      );
}

void showSnack(BuildContext context, String msg) =>
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

/// Small status chip (e.g. "Recording", "Idle").
class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.label, required this.color, this.icon});
  final String label;
  final Color color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(12)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon ?? Icons.circle, size: 10, color: color),
          const SizedBox(width: 4),
          Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
        ]),
      );
}

/// Recording status chip for a camera, loaded lazily.
class RecordingChip extends ConsumerWidget {
  const RecordingChip({super.key, required this.status});
  final AsyncValue<dynamic> status;

  @override
  Widget build(BuildContext context, WidgetRef ref) => status.when(
        data: (s) => s.active == true
            ? const StatusChip(label: 'Recording', color: Colors.red, icon: Icons.fiber_manual_record)
            : const StatusChip(label: 'Idle', color: Colors.grey),
        loading: () => const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2)),
        error: (_, _) => const StatusChip(label: 'Unknown', color: Colors.orange),
      );
}
