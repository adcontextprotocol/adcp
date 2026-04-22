// Test environment setup for vitest
// Sets up mock environment variables for testing

process.env.REVENUE_TRACKING_DISABLED = 'true';
process.env.NODE_ENV = 'test';

// WorkOS credentials (mock values for testing)
process.env.WORKOS_API_KEY = 'sk_test_mock_key';
process.env.WORKOS_CLIENT_ID = 'client_mock_id';

// Externally-reachable URL the MCP router uses for its OAuth issuer
// metadata. Needs to parse as a valid URL at server-construction time —
// `mcpAuthRouter` runs `new URL(...)` at setup. Setting a known-good value
// here means integration tests that construct an `HTTPServer` don't
// depend on the surrounding env.
// Force a known-good URL. The shell sometimes sets BASE_URL to "/" (conductor
// workspace config), which passes the || guard but strips to "" after
// `.replace(/\/$/, '')`, then throws on `new URL('')` at MCP router setup.
process.env.BASE_URL = 'http://localhost:3000';
