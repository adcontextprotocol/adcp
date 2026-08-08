/**
 * AAO Secretariat GitHub App authentication.
 *
 * Mints short-lived installation tokens from the Secretariat GitHub App
 * credentials (SECRETARIAT_APP_ID + SECRETARIAT_APP_PRIVATE_KEY) so
 * server-side GitHub writes author as `aao-secretariat[bot]` instead of
 * a personal PAT. `resolveGitHubToken()` is the single seam callers use:
 * App token when the App is configured, legacy GITHUB_TOKEN PAT during
 * migration, null when neither exists. When the App IS configured, a
 * mint failure fails closed — it never silently degrades to the PAT.
 */

import { createSign } from 'node:crypto';
import { createLogger } from '../../logger.js';

const logger = createLogger('github-app-token');

const API_TIMEOUT_MS = 10_000;
/** Refresh the cached installation token when under 5 minutes remain. */
const EXPIRY_BUFFER_MS = 5 * 60_000;

let cachedToken: { token: string; expiresAtMs: number } | null = null;
let cachedInstallationId: number | null = null;

/** Test seam: clear module-level caches between test cases. */
export function resetGitHubAppTokenCache(): void {
  cachedToken = null;
  cachedInstallationId = null;
}

export function isSecretariatAppConfigured(): boolean {
  return Boolean(process.env.SECRETARIAT_APP_ID && process.env.SECRETARIAT_APP_PRIVATE_KEY);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Short-lived app JWT (RS256, self-signed with the App private key).
 * iat is backdated 60s per GitHub's clock-drift guidance.
 */
function mintAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

async function ghFetch(url: string, bearer: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aao-secretariat/1.0',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function lookupInstallationId(jwt: string): Promise<number> {
  if (cachedInstallationId !== null) return cachedInstallationId;
  const resp = await ghFetch('https://api.github.com/app/installations', jwt);
  if (!resp.ok) {
    throw new Error(`Secretariat App installation lookup failed: ${resp.status}`);
  }
  const installations = (await resp.json()) as Array<{ id: number }>;
  if (installations.length === 0) {
    throw new Error('Secretariat App has no installations');
  }
  // The App is installed on exactly one account (the org) by design.
  cachedInstallationId = installations[0].id;
  return cachedInstallationId;
}

async function mintInstallationToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs - Date.now() > EXPIRY_BUFFER_MS) {
    return cachedToken.token;
  }
  const appId = process.env.SECRETARIAT_APP_ID!;
  // Tolerate PEMs stored with escaped newlines (common env-var mangling).
  const privateKey = process.env.SECRETARIAT_APP_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const jwt = mintAppJwt(appId, privateKey);
  const installationId = await lookupInstallationId(jwt);
  const resp = await ghFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' }
  );
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Secretariat App token mint failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAtMs: Date.parse(data.expires_at) };
  return data.token;
}

/**
 * The GitHub credential every server-side GitHub write should use.
 * Returns null when no credential is available or the configured App
 * fails to mint (fail closed — callers already treat null as "cannot
 * write to GitHub right now").
 */
export async function resolveGitHubToken(): Promise<string | null> {
  if (isSecretariatAppConfigured()) {
    try {
      return await mintInstallationToken();
    } catch (err) {
      logger.error({ err }, 'Secretariat App token mint failed; failing closed');
      return null;
    }
  }
  return process.env.GITHUB_TOKEN || null;
}
