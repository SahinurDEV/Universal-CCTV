/// Validation / normalisation of the user-entered API server URL.
library;

class ServerUrlResult {
  const ServerUrlResult._(this.url, this.error, this.insecure);
  final String? url;
  final String? error;

  /// True for plain-http URLs that are not loopback / private-LAN hosts.
  final bool insecure;

  bool get ok => url != null;
}

final _privateHost = RegExp(
  r'^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|[a-z0-9-]+\.local)$',
);

ServerUrlResult normalizeServerUrl(String input) {
  var s = input.trim();
  if (s.isEmpty) return const ServerUrlResult._(null, 'Enter the server address', false);
  if (!s.contains('://')) s = 'https://$s';
  final uri = Uri.tryParse(s);
  if (uri == null || uri.host.isEmpty) return const ServerUrlResult._(null, 'Not a valid URL', false);
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    return const ServerUrlResult._(null, 'Only http:// or https:// are supported', false);
  }
  if (uri.userInfo.isNotEmpty) return const ServerUrlResult._(null, 'Do not put credentials in the URL', false);
  if (uri.hasQuery || uri.hasFragment) return const ServerUrlResult._(null, 'Remove the query string', false);
  var path = uri.path;
  while (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  final normalized = uri.replace(path: path).toString();
  final insecure = uri.scheme == 'http' && !_privateHost.hasMatch(uri.host.toLowerCase());
  return ServerUrlResult._(normalized, null, insecure);
}
