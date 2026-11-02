/**
 * Per-caller sandbox state for the experimental 3.3 account surfaces:
 * the sandbox clock, the caller's grant on each account, and account
 * timezone changes.
 *
 * - **Clock.** One virtual clock per caller (`simulated_now`). Until a
 *   storyboard moves it with `reporting_subscription_probe` `advance_time`, it
 *   reads the wall clock. Once moved it stays at the target instant, so every
 *   later timestamp the caller's sandbox issues is deterministic. It only moves
 *   forward. `reset_state` discards it with the rest of the caller's sandbox.
 * - **Grants.** The caller's authorization on each account it holds: the
 *   chain start (`authorized_at`), the latest re-grant in the chain
 *   (`regranted_at`), a revocation (`unauthorized_at`), and an optional reduced
 *   `allowed_tasks`. A revoked account is unknown to every task but the
 *   controller. The grant history is kept so coverage can be computed as a
 *   chain of grants, as `core/account-authorization.json` describes.
 * - **Timezone changes.** Each change of an account's timezone, so
 *   account-timezone reporting periods can cut over (`timezone_cutovers`).
 *
 * State lives in the training agent's session store under a caller-scoped
 * key. As with `principal.ts`, every holder of the shared public sandbox token
 * is one caller, so they share one clock. Do not copy that keying into a
 * production seller.
 */
import { getSession, sessionKeyFromArgs } from './state.js';
import type { SessionState } from './types.js';

export const SANDBOX_DOC_PREFIX = 'account_sandbox\u001f';
/** Advertised `status_retention_days`: the window in which a re-grant
 * continues the authorization chain. Exact 24-hour days. */
export const STATUS_RETENTION_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrantInterval {
  authorized_at: string;
  unauthorized_at?: string;
}

export interface GrantRecord {
  /** Start of the current authorization chain. */
  authorized_at: string;
  /** Latest re-grant that continued the current chain. */
  regranted_at?: string;
  /** Present while the grant is revoked. */
  unauthorized_at?: string;
  /** Reduced grant. Absent means the full default grant. */
  allowed_tasks?: string[];
  read_only?: boolean;
  /** Every grant interval, oldest first, across chains. */
  history: GrantInterval[];
}

export interface TimezoneChange {
  /** The instant the change was applied (simulated_now). */
  at: string;
  previous_timezone: string;
  timezone: string;
}

export interface SandboxDocument extends Record<string, unknown> {
  simulated_now?: string;
  /** One entry per account. Arrays, not maps keyed by caller-supplied
   * account IDs, so no account ID ever becomes a property name. */
  grants: Array<GrantRecord & { account_id: string }>;
  timezone_changes: Array<{ account_id: string; changes: TimezoneChange[] }>;
}

export interface LoadedSandbox {
  session: SessionState;
  key: string;
  doc: SandboxDocument;
  save(): void;
}

function principalKey(principal: string | undefined): string {
  return principal && principal.length > 0 ? principal : 'anonymous';
}

function emptyDocument(): SandboxDocument {
  return { grants: [], timezone_changes: [] };
}

/** The caller's grant on an account, if one is recorded. */
export function grantFor(doc: SandboxDocument, accountId: string): GrantRecord | undefined {
  return doc.grants.find(grant => grant.account_id === accountId);
}

/** The account's recorded timezone changes, oldest first. */
export function timezoneChangesFor(doc: SandboxDocument, accountId: string): TimezoneChange[] {
  return doc.timezone_changes.find(entry => entry.account_id === accountId)?.changes ?? [];
}

export async function loadSandbox(principal: string | undefined): Promise<LoadedSandbox> {
  const caller = principalKey(principal);
  const session = await getSession(sessionKeyFromArgs({}, 'open', undefined, undefined, caller));
  const key = `${SANDBOX_DOC_PREFIX}${caller}`;
  const stored = session.principalConfigurations.get(key) as SandboxDocument | undefined;
  const doc: SandboxDocument = stored
    ? {
        ...structuredClone(stored),
        grants: Array.isArray(stored.grants) ? structuredClone(stored.grants) : [],
        timezone_changes: Array.isArray(stored.timezone_changes) ? structuredClone(stored.timezone_changes) : [],
      }
    : emptyDocument();
  return {
    session,
    key,
    doc,
    save() {
      session.principalConfigurations.set(key, structuredClone(doc));
    },
  };
}

/** Discard the caller's sandbox clock, grants, and timezone history. */
export async function resetSandbox(principal: string | undefined): Promise<void> {
  const loaded = await loadSandbox(principal);
  loaded.session.principalConfigurations.delete(loaded.key);
}

export function sandboxNowMs(doc: SandboxDocument): number {
  const simulated = doc.simulated_now ? Date.parse(doc.simulated_now) : Number.NaN;
  return Number.isFinite(simulated) ? simulated : Date.now();
}

export function sandboxNowIso(doc: SandboxDocument): string {
  return new Date(sandboxNowMs(doc)).toISOString();
}

/** The caller's current sandbox time, for read paths that do not mutate. */
export async function callerSandboxNowMs(principal: string | undefined): Promise<number> {
  return sandboxNowMs((await loadSandbox(principal)).doc);
}

/**
 * Record the default grant for an account the caller holds, at the caller's
 * sandbox time, if none is recorded yet. Returns whether the document changed.
 */
export function ensureGrant(doc: SandboxDocument, accountId: string, nowIso: string): boolean {
  if (grantFor(doc, accountId)) return false;
  doc.grants.push({ account_id: accountId, authorized_at: nowIso, history: [{ authorized_at: nowIso }] });
  return true;
}

export function isRevoked(doc: SandboxDocument, accountId: string): boolean {
  return grantFor(doc, accountId)?.unauthorized_at !== undefined;
}

/** Whether the caller's grant on the account is revoked (unknown account). */
export async function callerGrantRevoked(principal: string | undefined, accountId: string): Promise<boolean> {
  return isRevoked((await loadSandbox(principal)).doc, accountId);
}

/** Tasks the training agent serves against an account under the full grant. */
export const DEFAULT_ACCOUNT_TASKS: readonly string[] = Object.freeze([
  'accept_proposal',
  'buy_products',
  'build_creative',
  'control_media_buy',
  'create_media_buy',
  'decline_proposals',
  'get_media_buy_delivery',
  'get_media_buys',
  'get_products',
  'get_reporting_status',
  'list_account_changes',
  'list_accounts',
  'list_creative_formats',
  'list_creatives',
  'list_products',
  'log_event',
  'preview_creative',
  'provide_performance_feedback',
  'refine_proposals',
  'report_usage',
  'request_account',
  'request_proposals',
  'sync_accounts',
  'sync_audiences',
  'sync_catalogs',
  'sync_creatives',
  'sync_event_sources',
  'sync_governance',
  'sync_reporting_receipts',
  'sync_reporting_status',
  'update_media_buy',
  'validate_input',
]);

/** The wire `authorization` object for an account the caller is granted. */
export function authorizationFor(grant: GrantRecord): Record<string, unknown> {
  return {
    allowed_tasks: grant.allowed_tasks ? [...grant.allowed_tasks] : [...DEFAULT_ACCOUNT_TASKS],
    read_only: grant.read_only === true,
    authorized_at: grant.authorized_at,
    ...(grant.regranted_at && { regranted_at: grant.regranted_at }),
  };
}

/** Whether the caller's grant permits `task` on the account. Revocation is
 * handled separately: a revoked account is unknown, not out of scope. */
export function grantPermits(grant: GrantRecord | undefined, task: string): boolean {
  if (!grant?.allowed_tasks) return true;
  return grant.allowed_tasks.includes(task);
}

export function revokeGrant(doc: SandboxDocument, accountId: string, nowIso: string): GrantRecord {
  ensureGrant(doc, accountId, nowIso);
  const grant = grantFor(doc, accountId)!;
  if (grant.unauthorized_at) return grant;
  grant.unauthorized_at = nowIso;
  const last = grant.history[grant.history.length - 1];
  if (last && last.unauthorized_at === undefined) last.unauthorized_at = nowIso;
  return grant;
}

export function regrantGrant(
  doc: SandboxDocument,
  accountId: string,
  nowIso: string,
): { grant: GrantRecord; chain: 'continued' | 'new' } {
  const created = ensureGrant(doc, accountId, nowIso);
  const grant = grantFor(doc, accountId)!;
  // A re-grant restores the full grant.
  delete grant.allowed_tasks;
  delete grant.read_only;
  if (created || grant.unauthorized_at === undefined) {
    return { grant, chain: created ? 'new' : 'continued' };
  }
  const revokedMs = Date.parse(grant.unauthorized_at);
  const nowMs = Date.parse(nowIso);
  delete grant.unauthorized_at;
  grant.history.push({ authorized_at: nowIso });
  if (nowMs < revokedMs + STATUS_RETENTION_DAYS * DAY_MS) {
    grant.regranted_at = nowIso;
    return { grant, chain: 'continued' };
  }
  grant.authorized_at = nowIso;
  delete grant.regranted_at;
  return { grant, chain: 'new' };
}

export function reduceGrant(
  doc: SandboxDocument,
  accountId: string,
  allowedTasks: string[],
  nowIso: string,
): GrantRecord {
  ensureGrant(doc, accountId, nowIso);
  const grant = grantFor(doc, accountId)!;
  grant.allowed_tasks = [...new Set(allowedTasks)].sort();
  grant.read_only = false;
  return grant;
}

export function recordTimezoneChange(
  doc: SandboxDocument,
  accountId: string,
  change: TimezoneChange,
): void {
  const entry = doc.timezone_changes.find(candidate => candidate.account_id === accountId);
  if (entry) entry.changes.push(change);
  else doc.timezone_changes.push({ account_id: accountId, changes: [change] });
}

export function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  // Numeric offsets are not IANA zone names.
  if (/^[+-]?\d/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
