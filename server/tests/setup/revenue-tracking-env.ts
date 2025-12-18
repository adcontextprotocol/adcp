// Test environment setup for vitest
// Sets up mock environment variables for testing

process.env.REVENUE_TRACKING_DISABLED = 'true';
process.env.NODE_ENV = 'test';

// WorkOS credentials (mock values for testing)
process.env.WORKOS_API_KEY = 'sk_test_mock_key';
process.env.WORKOS_CLIENT_ID = 'client_mock_id';
