/**
 * Detect Stripe-key-mode vs DATABASE_URL environment mismatch. A staging app
 * pointed at a live Stripe key (or vice versa) would surface thousands of
 * phantom critical violations because the Stripe-side state and the AAO-side
 * state describe entirely different worlds. Cheap heuristic: if the URL host
 * looks like prod and the key is `sk_test_*`, refuse. Returns null when no
 * mismatch is detected.
 */
export function detectEnvMismatch(): string | null {
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!stripeKey || !databaseUrl) return null;

  const isLiveKey = stripeKey.startsWith('sk_live_');
  const isTestKey = stripeKey.startsWith('sk_test_');

  // Parse the URL and inspect its host explicitly. Substring checks against
  // the raw URL string would match a hostile path/query like
  // postgres://user@evil.example/?aao-prod=1.
  let host = '';
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }

  // Fly.io serves private services to the prod app over `*.flycast` and
  // `*.internal` (6PN). Recognize Fly prod patterns plus a positive
  // FLY_APP_NAME signal so the runner is unblocked there without
  // loosening the staging guard.
  const PROD_FLY_APPS = (process.env.AAO_PROD_FLY_APPS ?? 'adcp-docs')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const flyAppName = (process.env.FLY_APP_NAME ?? '').toLowerCase();
  const isFlyProdApp = !!flyAppName && PROD_FLY_APPS.includes(flyAppName);
  const looksProd =
    host.endsWith('.agenticadvertising.org') ||
    host === 'agenticadvertising.org' ||
    host.startsWith('aao-prod') ||
    host.endsWith('.fly.dev') ||
    host.endsWith('.flycast') ||
    host.endsWith('.internal') ||
    isFlyProdApp;

  if (looksProd && isTestKey) {
    return 'STRIPE_SECRET_KEY is sk_test_* but DATABASE_URL points at production. Refusing to run integrity checks against this mismatched configuration.';
  }
  if (!looksProd && isLiveKey) {
    return 'STRIPE_SECRET_KEY is sk_live_* but DATABASE_URL does not look like production. Refusing to run integrity checks — would attribute live Stripe state against staging Postgres.';
  }
  return null;
}
