import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';

const _destinations = [
  (path: '/cameras', icon: Icons.videocam_outlined, selected: Icons.videocam, label: 'Cameras'),
  (path: '/live', icon: Icons.grid_view_outlined, selected: Icons.grid_view, label: 'Live'),
  (path: '/alerts', icon: Icons.notifications_outlined, selected: Icons.notifications, label: 'Alerts'),
  (path: '/settings', icon: Icons.settings_outlined, selected: Icons.settings, label: 'Settings'),
];

/// Bottom navigation on phones, navigation rail on tablets / landscape.
class HomeShell extends ConsumerWidget {
  const HomeShell({super.key, required this.location, required this.child});
  final String location;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final index = _destinations.indexWhere((d) => location.startsWith(d.path)).clamp(0, 3);
    final unread = ref.watch(alertsProvider).value?.unread ?? 0;
    Widget icon(int i, bool sel) {
      final d = _destinations[i];
      final ic = Icon(sel ? d.selected : d.icon);
      return i == 2 && unread > 0 ? Badge(label: Text('$unread'), child: ic) : ic;
    }

    void go(int i) => context.go(_destinations[i].path);
    final suspended = ref.watch(sessionProvider).value?.me?.activeTenant?.suspended ?? false;
    final body = suspended
        ? Column(children: [
            MaterialBanner(
              key: const Key('suspendedBanner'),
              backgroundColor: Theme.of(context).colorScheme.errorContainer,
              leading: const Icon(Icons.block),
              content: const Text('This workspace has been suspended by the platform operator. Contact support.'),
              actions: [TextButton(onPressed: () => showWorkspaceSwitcher(context, ref), child: const Text('Switch'))],
            ),
            Expanded(child: child),
          ])
        : child;

    if (context.isWide) {
      return Scaffold(
        body: Row(children: [
          NavigationRail(
            selectedIndex: index,
            onDestinationSelected: go,
            labelType: NavigationRailLabelType.all,
            leading: const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: WorkspaceButton()),
            destinations: [
              for (var i = 0; i < _destinations.length; i++)
                NavigationRailDestination(icon: icon(i, false), selectedIcon: icon(i, true), label: Text(_destinations[i].label)),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: body),
        ]),
      );
    }
    return Scaffold(
      body: body,
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: go,
        destinations: [
          for (var i = 0; i < _destinations.length; i++)
            NavigationDestination(icon: icon(i, false), selectedIcon: icon(i, true), label: _destinations[i].label),
        ],
      ),
    );
  }
}

/// App-bar action showing the active workspace and opening the switcher.
class WorkspaceButton extends ConsumerWidget {
  const WorkspaceButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(sessionProvider).value?.me;
    if (me == null) return const SizedBox.shrink();
    return IconButton(
      key: const Key('workspaceButton'),
      tooltip: 'Workspace: ${me.activeTenant?.name ?? 'none'}',
      icon: const Icon(Icons.business),
      onPressed: () => showWorkspaceSwitcher(context, ref),
    );
  }
}

Future<void> showWorkspaceSwitcher(BuildContext context, WidgetRef ref) async {
  final me = ref.read(sessionProvider).value?.me;
  if (me == null) return;
  final picked = await showModalBottomSheet<String>(
    context: context,
    builder: (c) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        const ListTile(title: Text('Switch workspace', style: TextStyle(fontWeight: FontWeight.bold))),
        for (final t in me.tenants)
          ListTile(
            leading: Icon(t.id == me.activeTenantId ? Icons.radio_button_checked : Icons.radio_button_off),
            title: Text(t.name),
            subtitle: Text(t.role),
            onTap: () => Navigator.pop(c, t.id),
          ),
      ]),
    ),
  );
  if (picked == null || picked == me.activeTenantId) return;
  try {
    await ref.read(sessionProvider.notifier).switchTenant(picked);
  } catch (e) {
    if (context.mounted) showSnack(context, errorText(e));
  }
}
