// Test environment setup for vitest
// Sets up mock environment variables for testing
//
// This file re-runs before every test file (vitest resets the module
// registry per file, and setup files are part of that registry), but
// `process.env` itself is a real Node object that outlives the reset --
// with `fileParallelism: false` the whole ~455-file suite shares one
// forked worker process. Individual test files set ad-hoc vars in
// `vi.hoisted()` blocks (ADMIN_API_KEY, ADMIN_EMAILS, DEV_USER_EMAIL, ...)
// to exercise auth boundaries and never restore them. Left alone, those
// mutations bleed into every file that runs afterward in the same worker,
// producing a rotating single-test flake (a different downstream file
// breaks each run, depending on file scheduling order).
//
// Snapshot the environment exactly once per worker process, before any
// test file's mutations happen, and restore it before every file so each
// file starts from the same pristine baseline regardless of what earlier
// files left behind.
const ENV_BASELINE_KEY = '__adcp_server_unit_env_baseline__';
type GlobalWithEnvBaseline = typeof globalThis & {
  [ENV_BASELINE_KEY]?: Record<string, string | undefined>;
};
const globalWithBaseline = globalThis as GlobalWithEnvBaseline;

if (!globalWithBaseline[ENV_BASELINE_KEY]) {
  globalWithBaseline[ENV_BASELINE_KEY] = { ...process.env };
} else {
  const baseline = globalWithBaseline[ENV_BASELINE_KEY];
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline)) delete process.env[key];
  }
  Object.assign(process.env, baseline);
}

process.env.REVENUE_TRACKING_DISABLED = 'true';
process.env.NODE_ENV = 'test';

// WorkOS credentials (mock values for testing). Including WORKOS_COOKIE_PASSWORD
// at >=32 chars so AUTH_ENABLED resolves true and the WorkOS client gets
// constructed — routes that reach for `workos!.userManagement` etc. would
// otherwise hit "Cannot read properties of null".
process.env.WORKOS_API_KEY = 'sk_test_mock_key';
process.env.WORKOS_CLIENT_ID = 'client_mock_id';
process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-chars-long';

