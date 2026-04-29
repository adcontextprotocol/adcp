// Test environment setup for vitest
// Sets up mock environment variables for testing

process.env.REVENUE_TRACKING_DISABLED = 'true';
process.env.NODE_ENV = 'test';

// WorkOS credentials (mock values for testing). Including WORKOS_COOKIE_PASSWORD
// at >=32 chars so AUTH_ENABLED resolves true and the WorkOS client gets
// constructed — routes that reach for `workos!.userManagement` etc. would
// otherwise hit "Cannot read properties of null".
process.env.WORKOS_API_KEY = 'sk_test_mock_key';
process.env.WORKOS_CLIENT_ID = 'client_mock_id';
process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-chars-long';

