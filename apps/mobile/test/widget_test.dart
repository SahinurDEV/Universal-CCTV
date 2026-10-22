import 'package:cctv_mobile/app.dart';
import 'package:cctv_mobile/core/models.dart';
import 'package:cctv_mobile/core/providers.dart';
import 'package:cctv_mobile/core/storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

Future<(MemoryAppStorage, List<FakeApi>)> pumpApp(WidgetTester tester, {Map<String, String>? stored, Size size = const Size(400, 800)}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final storage = MemoryAppStorage(stored);
  final apis = <FakeApi>[];
  await tester.pumpWidget(ProviderScope(
    overrides: [
      storageProvider.overrideWithValue(storage),
      apiClientFactoryProvider.overrideWithValue((url, token, _) {
        final a = FakeApi(token: token);
        apis.add(a);
        return a;
      }),
    ],
    child: const CctvApp(),
  ));
  await tester.pumpAndSettle();
  return (storage, apis);
}

void main() {
  testWidgets('first run asks for server, then login, then shows cameras', (tester) async {
    final (storage, _) = await pumpApp(tester);
    expect(find.byKey(const Key('serverUrl')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('serverUrl')), 'cctv.test');
    await tester.tap(find.byKey(const Key('serverContinue')));
    await tester.pumpAndSettle();
    expect(storage.values[StorageKeys.serverUrl], 'https://cctv.test');
    expect(find.text('Sign in'), findsWidgets);

    await tester.enterText(find.byKey(const Key('email')), 'owner@example.com');
    await tester.enterText(find.byKey(const Key('password')), 'wrong');
    await tester.tap(find.byKey(const Key('loginSubmit')));
    await tester.pumpAndSettle();
    expect(find.text('Incorrect email or password.'), findsOneWidget);
    expect(storage.values[StorageKeys.token], isNull);

    await tester.enterText(find.byKey(const Key('password')), 'secret');
    await tester.tap(find.byKey(const Key('loginSubmit')));
    await tester.pumpAndSettle();
    expect(storage.values[StorageKeys.token], testToken);
    expect(find.text('Lobby'), findsOneWidget);
    expect(find.text('Parking'), findsOneWidget);
    expect(find.text('Recording'), findsOneWidget);
    expect(find.textContaining('Front office'), findsOneWidget);
    expect(find.textContaining('Unassigned'), findsOneWidget);
  });

  testWidgets('restores a stored session and logs out (wipes token, revokes server-side)', (tester) async {
    final (storage, apis) = await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken});
    expect(find.text('Lobby'), findsOneWidget);

    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('logout')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirmLogout')));
    await tester.pumpAndSettle();

    expect(storage.values[StorageKeys.token], isNull);
    expect(apis.any((a) => a.calls.contains('logout')), isTrue);
    expect(find.byKey(const Key('loginSubmit')), findsOneWidget);
  });

  testWidgets('invalid stored token goes to login', (tester) async {
    final storage = {StorageKeys.serverUrl: 'https://cctv.test'};
    await pumpApp(tester, stored: storage);
    expect(find.byKey(const Key('loginSubmit')), findsOneWidget);
  });

  testWidgets('alerts show detection labels and unread badge', (tester) async {
    await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken});
    await tester.tap(find.text('Alerts'));
    await tester.pumpAndSettle();
    expect(find.text('Person detected on Lobby'), findsOneWidget);
    expect(find.text('person 91%'), findsOneWidget);
    expect(find.text('car 55%'), findsOneWidget);
    expect(find.text('Camera offline'), findsOneWidget);
    expect(find.text('1'), findsOneWidget); // badge
  });

  testWidgets('camera detail toggles motion detection and alert classes', (tester) async {
    final (_, apis) = await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken});
    await tester.tap(find.text('Lobby'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Stream'), findsNothing);

    await tester.scrollUntilVisible(find.byKey(const Key('motionToggle')), 200);
    await tester.tap(find.byKey(const Key('motionToggle')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('class-person')), 200);
    await tester.tap(find.byKey(const Key('class-person')));
    await tester.pumpAndSettle();

    final calls = apis.expand((a) => a.calls).toList();
    expect(calls, contains('motion:true:any'));
    expect(calls, contains('motion:true:person'));
  });

  testWidgets('PTZ controls move, stop and go to a preset', (tester) async {
    final (_, apis) = await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken});
    await tester.tap(find.text('Lobby'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ptzControls')), findsOneWidget);
    await tester.tap(find.byKey(const Key('ptz-right')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('preset-p1')));
    await tester.pump();
    final calls = apis.expand((a) => a.calls).toList();
    expect(calls, contains('ptz:move:0.5:0.0:0.0'));
    expect(calls, contains('ptz:stop'));
    expect(calls, contains('ptz:goto:p1'));
  });

  testWidgets('PTZ controls are hidden for cameras without PTZ', (tester) async {
    final (_, apis) = await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken});
    for (final a in apis) {
      a.ptzInfo = const PtzInfo(supported: false, zoom: false, canControl: true);
    }
    await tester.tap(find.text('Lobby'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ptzControls')), findsNothing);
  });

  testWidgets('workspace switcher changes the active tenant', (tester) async {
    final (_, apis) = await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken});
    await tester.tap(find.byKey(const Key('workspaceButton')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Branch'));
    await tester.pumpAndSettle();
    expect(apis.expand((a) => a.calls), contains('switch:t2'));
    expect(find.text('Branch'), findsOneWidget); // subtitle in app bar
  });

  testWidgets('wide layout uses a navigation rail and dark mode can be selected', (tester) async {
    await pumpApp(tester, stored: {StorageKeys.serverUrl: 'https://cctv.test', StorageKeys.token: testToken}, size: const Size(1200, 800));
    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dark'));
    await tester.pumpAndSettle();
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.themeMode, ThemeMode.dark);
  });
}
