// Test environment setup for vitest
// Sets up mock environment variables for testing

import { vi } from 'vitest';

// This file runs before every test file, in the same worker process. Unit
// test files share workers (`isolate: false` in server/vitest.config.ts),
// so `process.env` and globals outlive each file. Test files change them
// with `vi.stubEnv` / `vi.stubGlobal`; `unstubEnvs` / `unstubGlobals`
// undo those before every test, and the two calls below also undo the
// last test's stubs before this file's imports run, so module-load reads
// never see the previous file's values. Direct `process.env` writes are
// not undone: use `vi.stubEnv` instead (scripts/vitest-leak-inventory.json
// tracks the files that still write it directly).
vi.unstubAllEnvs();
vi.unstubAllGlobals();

// Developer shells (Conductor's `.env.local`, local `.env` files) commonly
// export dev-login and break-glass admin credentials. `server/src/middleware/
// auth.ts` reads these at module load: DEV_USER_EMAIL + DEV_USER_ID flip
// `DEV_MODE_ENABLED`, which bypasses the WorkOS session path every auth
// unit test exercises, and ADMIN_API_KEY / ADMIN_EMAILS widen platform-admin
// checks. CI never sets them, so a suite that passes there fails locally
// (#7478). Scrub them so the unit suite behaves the same in every shell;
// files that exercise these boundaries set them explicitly in `vi.hoisted()`.
for (const key of [
  'DEV_USER_EMAIL',
  'DEV_USER_ID',
  'ALLOW_DEV_MODE_IN_PROD',
  'ADMIN_API_KEY',
  'ADMIN_EMAILS',
]) {
  delete process.env[key];
}

process.env.REVENUE_TRACKING_DISABLED = 'true';
process.env.NODE_ENV = 'test';

// Unit tests must not fetch or reset repository caches in developer checkouts.
process.env.SKIP_REPO_INDEX = 'true';

// src/training-agent/index.ts builds its bearer authenticators at import from
// PUBLIC_TEST_AGENT_TOKEN, and a shared worker imports it once for every
// file. One value for every file keeps the cached authenticator valid; tests
// that call the training agent send `Bearer test-token`.
process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

// WorkOS credentials (mock values for testing). Including WORKOS_COOKIE_PASSWORD
// at >=32 chars so AUTH_ENABLED resolves true and the WorkOS client gets
// constructed — routes that reach for `workos!.userManagement` etc. would
// otherwise hit "Cannot read properties of null".
process.env.WORKOS_API_KEY = 'sk_test_mock_key';
process.env.WORKOS_CLIENT_ID = 'client_mock_id';
process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-chars-long';
