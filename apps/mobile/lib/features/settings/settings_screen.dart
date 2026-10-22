import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/push.dart';
import '../../core/providers.dart';
import '../auth/login_screen.dart';
import '../shell/home_shell.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  String? _push;
  bool _pushBusy = false;

  Future<void> _enablePush() async {
    setState(() => _pushBusy = true);
    final s = await PushService.register(ref.read(apiProvider)!, deviceName: defaultDeviceName());
    if (mounted) {
      setState(() {
        _push = pushStatusText(s);
        _pushBusy = false;
      });
    }
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('This device will stop receiving push alerts.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(key: const Key('confirmLogout'), onPressed: () => Navigator.pop(c, true), child: const Text('Sign out')),
        ],
      ),
    );
    if (ok != true) return;
    await PushService.unregisterLocal();
    await ref.read(sessionProvider.notifier).logout();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(sessionProvider).value;
    final me = s?.me;
    final mode = ref.watch(themeModeProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(children: [
        if (me != null)
          ListTile(
            leading: const CircleAvatar(child: Icon(Icons.person)),
            title: Text(me.user.displayName ?? me.user.email),
            subtitle: Text(me.user.email),
          ),
        ListTile(
          leading: const Icon(Icons.business),
          title: const Text('Workspace'),
          subtitle: Text(me?.activeTenant != null ? '${me!.activeTenant!.name} (${me.activeTenant!.role})' : 'None selected'),
          trailing: const Icon(Icons.swap_horiz),
          onTap: () => showWorkspaceSwitcher(context, ref),
        ),
        ListTile(leading: const Icon(Icons.dns_outlined), title: const Text('Server'), subtitle: Text(s?.serverUrl ?? '')),
        const Divider(),
        const ListTile(title: Text('Appearance')),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SegmentedButton<ThemeMode>(
            segments: const [
              ButtonSegment(value: ThemeMode.system, label: Text('System'), icon: Icon(Icons.brightness_auto)),
              ButtonSegment(value: ThemeMode.light, label: Text('Light'), icon: Icon(Icons.light_mode)),
              ButtonSegment(value: ThemeMode.dark, label: Text('Dark'), icon: Icon(Icons.dark_mode)),
            ],
            selected: {mode},
            onSelectionChanged: (v) => ref.read(themeModeProvider.notifier).set(v.first),
          ),
        ),
        const Divider(),
        ListTile(
          leading: const Icon(Icons.notifications_active_outlined),
          title: const Text('Push notifications'),
          subtitle: Text(_push ??
              (FirebaseConfig.supportedPlatform
                  ? 'Get alerts on this device (choose alert types in the web dashboard).'
                  : 'Available in the Android and iOS apps.')),
          trailing: _pushBusy
              ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : TextButton(onPressed: FirebaseConfig.supportedPlatform ? _enablePush : null, child: const Text('Enable')),
        ),
        const Divider(),
        ListTile(
          key: const Key('logout'),
          leading: Icon(Icons.logout, color: Theme.of(context).colorScheme.error),
          title: Text('Sign out', style: TextStyle(color: Theme.of(context).colorScheme.error)),
          onTap: _logout,
        ),
        const AboutListTile(icon: Icon(Icons.info_outline), applicationName: 'Universal CCTV', applicationVersion: '1.0.0'),
        Builder(builder: (context) => const SizedBox(height: 24)),
      ]),
    );
  }
}

