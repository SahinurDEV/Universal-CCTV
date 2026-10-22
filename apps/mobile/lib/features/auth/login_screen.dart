import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/providers.dart';

String defaultDeviceName() {
  if (kIsWeb) return 'Web browser';
  try {
    return '${Platform.operatingSystem[0].toUpperCase()}${Platform.operatingSystem.substring(1)} app';
  } catch (_) {
    return 'Mobile app';
  }
}

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(sessionProvider.notifier).login(_email.text.trim(), _password.text, deviceName: defaultDeviceName());
    } on ApiException catch (e) {
      setState(() => _error = e.friendly);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final server = ref.watch(sessionProvider).value?.serverUrl ?? '';
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: AutofillGroup(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const Icon(Icons.lock_outline, size: 48),
                    const SizedBox(height: 12),
                    Text('Sign in', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
                    const SizedBox(height: 4),
                    Text(server, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
                    const SizedBox(height: 24),
                    TextFormField(
                      key: const Key('email'),
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      autofillHints: const [AutofillHints.email],
                      decoration: const InputDecoration(labelText: 'Email'),
                      validator: (v) => (v == null || !v.contains('@')) ? 'Enter a valid email' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      key: const Key('password'),
                      controller: _password,
                      obscureText: _obscure,
                      autofillHints: const [AutofillHints.password],
                      decoration: InputDecoration(
                        labelText: 'Password',
                        suffixIcon: IconButton(
                          tooltip: _obscure ? 'Show password' : 'Hide password',
                          icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      validator: (v) => (v == null || v.isEmpty) ? 'Enter your password' : null,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!, key: const Key('loginError'), style: TextStyle(color: Theme.of(context).colorScheme.error)),
                    ],
                    const SizedBox(height: 16),
                    FilledButton(
                      key: const Key('loginSubmit'),
                      onPressed: _busy ? null : _submit,
                      child: _busy ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Sign in'),
                    ),
                    TextButton(onPressed: () => context.go('/server'), child: const Text('Change server')),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
