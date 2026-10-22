import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/providers.dart';
import '../../core/server_url.dart';
import '../../core/widgets.dart';

class ServerScreen extends ConsumerStatefulWidget {
  const ServerScreen({super.key});

  @override
  ConsumerState<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends ConsumerState<ServerScreen> {
  late final _ctrl = TextEditingController(text: ref.read(sessionProvider).value?.serverUrl ?? '');
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final r = normalizeServerUrl(_ctrl.text);
    if (!r.ok) return setState(() => _error = r.error);
    if (r.insecure) {
      final go = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Insecure connection'),
          content: const Text(
              'This server uses plain http:// over the internet. Your password and video would be sent unencrypted. Use https:// unless you trust the network.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Continue anyway')),
          ],
        ),
      );
      if (go != true) return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientFactoryProvider)(r.url!, null, () {}).checkHealth();
      await ref.read(sessionProvider.notifier).setServer(r.url!);
      if (mounted) context.go('/login');
    } on ApiException catch (e) {
      setState(() => _error = e.friendly);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  const Icon(Icons.videocam, size: 56),
                  const SizedBox(height: 12),
                  Text('Universal CCTV', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  const Text('Enter the address of your Universal CCTV API server.', textAlign: TextAlign.center),
                  const SizedBox(height: 24),
                  TextField(
                    key: const Key('serverUrl'),
                    controller: _ctrl,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: InputDecoration(
                      labelText: 'Server URL',
                      hintText: 'https://cctv.example.com/api',
                      errorText: _error,
                    ),
                    onSubmitted: (_) => _save(),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    key: const Key('serverContinue'),
                    onPressed: _busy ? null : _save,
                    child: _busy ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Continue'),
                  ),
                ]),
              ),
            ),
          ),
        ),
      );
}

/// Shown when the session couldn't be restored (e.g. server unreachable).
class StartupErrorScreen extends ConsumerWidget {
  const StartupErrorScreen({super.key, required this.error});
  final Object error;

  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      Scaffold(body: ErrorView(error: error, onRetry: () => ref.read(sessionProvider.notifier).retry()));
}
