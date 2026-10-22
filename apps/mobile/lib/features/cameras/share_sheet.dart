import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/providers.dart';

/// Bottom sheet that creates a public share link for a camera's live view or
/// a recent clip, then shows the link once with a Copy button.
Future<void> showShareSheet(BuildContext context, String cameraId) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: ShareSheet(cameraId: cameraId),
      ),
    );

class ShareSheet extends ConsumerStatefulWidget {
  const ShareSheet({super.key, required this.cameraId});
  final String cameraId;

  @override
  ConsumerState<ShareSheet> createState() => _ShareSheetState();
}

class _ShareSheetState extends ConsumerState<ShareSheet> {
  String _kind = 'LIVE';
  int _expiry = 60;
  int _clipMinutes = 10;
  final _password = TextEditingController();
  final _maxViews = TextEditingController();
  String? _url;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _password.dispose();
    _maxViews.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final api = ref.read(apiProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final now = DateTime.now();
      final url = await api.createShareLink(
        widget.cameraId,
        kind: _kind,
        expiresInMinutes: _expiry,
        clipStart: _kind == 'CLIP' ? now.subtract(Duration(minutes: _clipMinutes)) : null,
        clipEnd: _kind == 'CLIP' ? now.subtract(const Duration(seconds: 5)) : null,
        password: _password.text,
        maxViews: int.tryParse(_maxViews.text),
      );
      setState(() => _url = url);
    } on ApiException catch (e) {
      setState(() => _error = e.message ?? e.code);
    } catch (_) {
      setState(() => _error = 'Could not create link');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('Share camera', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          const Text('Anyone with the link can watch only this camera or clip, without logging in, until it expires or is revoked.'),
          const SizedBox(height: 12),
          SegmentedButton<String>(
            key: const Key('shareKind'),
            segments: const [
              ButtonSegment(value: 'LIVE', label: Text('Live')),
              ButtonSegment(value: 'CLIP', label: Text('Recent clip')),
            ],
            selected: {_kind},
            onSelectionChanged: (s) => setState(() => _kind = s.first),
          ),
          if (_kind == 'CLIP')
            DropdownButtonFormField<int>(
              initialValue: _clipMinutes,
              decoration: const InputDecoration(labelText: 'Clip length (ending now)'),
              items: const [5, 10, 30, 60].map((m) => DropdownMenuItem(value: m, child: Text('Last $m minutes'))).toList(),
              onChanged: (v) => setState(() => _clipMinutes = v ?? 10),
            ),
          DropdownButtonFormField<int>(
            key: const Key('shareExpiry'),
            initialValue: _expiry,
            decoration: const InputDecoration(labelText: 'Expires after'),
            items: const [
              DropdownMenuItem(value: 15, child: Text('15 minutes')),
              DropdownMenuItem(value: 60, child: Text('1 hour')),
              DropdownMenuItem(value: 1440, child: Text('24 hours')),
              DropdownMenuItem(value: 10080, child: Text('7 days')),
            ],
            onChanged: (v) => setState(() => _expiry = v ?? 60),
          ),
          TextField(key: const Key('sharePassword'), controller: _password, obscureText: true, decoration: const InputDecoration(labelText: 'Password (optional, min 6)')),
          TextField(key: const Key('shareMaxViews'), controller: _maxViews, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Max views (optional)')),
          const SizedBox(height: 12),
          FilledButton(key: const Key('shareCreate'), onPressed: _busy ? null : _create, child: Text(_busy ? 'Creating…' : 'Create link')),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          if (_url != null) ...[
            const SizedBox(height: 12),
            const Text('Copy this link now — it is only shown once.'),
            SelectableText(_url!, key: const Key('shareUrl')),
            TextButton.icon(
              key: const Key('shareCopy'),
              icon: const Icon(Icons.copy),
              label: const Text('Copy link'),
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: _url!));
                if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Link copied')));
              },
            ),
          ],
        ]),
      ),
    );
  }
}
