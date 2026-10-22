import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists the server URL, the bearer token and UI preferences.
/// The token lives only in the platform keystore (Keychain / Android Keystore).
abstract class AppStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);
}

class StorageKeys {
  static const serverUrl = 'server_url';
  static const token = 'session_token';
  static const themeMode = 'theme_mode';
}

class SecureAppStorage implements AppStorage {
  SecureAppStorage();
  static const _secure = FlutterSecureStorage();
  static const _secureKeys = {StorageKeys.token};

  @override
  Future<String?> read(String key) async {
    if (_secureKeys.contains(key)) return _secure.read(key: key);
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(key);
  }

  @override
  Future<void> write(String key, String? value) async {
    if (_secureKeys.contains(key)) {
      value == null ? await _secure.delete(key: key) : await _secure.write(key: key, value: value);
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    value == null ? await prefs.remove(key) : await prefs.setString(key, value);
  }
}

/// In-memory storage for tests.
class MemoryAppStorage implements AppStorage {
  MemoryAppStorage([Map<String, String>? initial]) : values = {...?initial};
  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String? value) async {
    value == null ? values.remove(key) : values[key] = value;
  }
}
