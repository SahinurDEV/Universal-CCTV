import 'package:flutter/material.dart';

const _seed = Color(0xFF2563EB);

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
    cardTheme: const CardThemeData(clipBehavior: Clip.antiAlias),
  );
}

/// Breakpoint helpers for phone / tablet layouts.
extension Responsive on BuildContext {
  double get width => MediaQuery.sizeOf(this).width;
  bool get isWide => width >= 840;
  int gridColumns({double minTile = 320}) => (width / minTile).floor().clamp(1, 4);
}
