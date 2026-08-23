// Pre-set env defaults that many root test files need for server module init.
// Runs once per worker before any test file, so individual files no longer
// need the `process.env.WORKOS_API_KEY ??= '...'` guard in vi.hoisted().
process.env.WORKOS_API_KEY ??= 'sk_test_default';
process.env.WORKOS_CLIENT_ID ??= 'client_test_default';
process.env.NODE_ENV ??= 'test';
