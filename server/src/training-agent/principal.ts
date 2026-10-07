/**
 * Experimental principal layer (`sync_principal` / `get_principal`) for the
 * training agent.
 *
 * Ownership is the stable authenticated caller, resolved only from transport
 * (never from request content). Reporting destinations and declarations live
 * in a principal-scoped session document. Principal configuration grants no
 * advertiser-account authority.
 *
 * Deliberate simplifications of this reference seller:
 * - Sections: `reporting_destinations` and `declarations`. Capability-change
 *   webhooks stay on `sync_agent_notification_configs`, which is why
 *   `notification_configs` is not advertised in `supported_sections` (the
 *   capability schema would then require `registration_task: sync_principal`,
 *   which the `agent_notification_configs` storyboard does not yet accept).
 * - Destination proof is simulated: an active destination reads back
 *   `action_required`, then `ready` after DESTINATION_PROOF_DELAY_MS. No
 *   outbound probe or provider grant happens and no `principal.changed`
 *   webhook is fired for the transition.
 * - Every authenticated caller is treated as an existing durable principal, so
 *   `get_principal` never returns `unconfigured`.
 * - State lives in the training agent's session store (last writer wins across
 *   machines), and every holder of the shared public sandbox token is one
 *   principal. Do not copy that keying into a production seller.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { agentNotificationDocumentId, trainingCallerPrincipal } from './agent-notification-configs.js';
import { validateSourceSchema } from './source-schema.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import {
  TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS,
  type SessionState,
  type ToolArgs,
  type TrainingContext,
} from './types.js';

type Json = Record<string, unknown>;
type PrincipalKind = 'buyer_agent' | 'operator';

const TENANT_ID = 'training-agent';

export const PRINCIPAL_SECTIONS = ['reporting_destinations', 'declarations'] as const;

/** Simulated provider-side proof latency. A destination applied with
 * `active: true` reads back `action_required` until this much time has passed,
 * then `ready`. Deterministic and read-only: no outbound probe is made. */
export const DESTINATION_PROOF_DELAY_MS = 5_000;
const SETUP_ACTION_TTL_MS = 60 * 60 * 1000;
const MAX_RETIRED_DESTINATIONS = 64;
const MAX_GENERATION_REFS = 32;

const SELLER_ASYNC_EXPERIMENTAL_FEATURES: readonly string[] = ['protocol.principal'];
/** Algorithms the seller signs webhooks with; also advertised in `webhook_signing`. */
export const SELLER_WEBHOOK_SIGNING_ALGORITHMS: readonly string[] = ['ed25519'];
const SELLER_ASYNC_ADCP_VERSIONS: readonly string[] = TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS
  .filter(version => /^\d+\.\d+$/.test(version));

/** Objective offering advertised in `adcp.principal`. */
export const PRINCIPAL_CAPABILITY = {
  supported: true,
  sync_task: 'sync_principal',
  read_task: 'get_principal',
  supported_sections: [...PRINCIPAL_SECTIONS],
  max_reporting_destinations: 16,
  reporting_destination_offerings: [
    {
      pattern: 'file_transfer',
      transports: ['s3', 'gcs'],
      formats: ['parquet', 'jsonl', 'csv'],
      verification_profiles: ['manifest_checksums', 'canonical_digest'],
    },
    {
      pattern: 'warehouse_materialization',
      transports: ['bigquery', 'snowflake'],
      verification_profiles: ['native_commit', 'canonical_digest'],
    },
  ],
  suspension_interval_seconds: 300,
  optimistic_concurrency: true,
} as const;

type Offering = (typeof PRINCIPAL_CAPABILITY.reporting_destination_offerings)[number];

interface DestinationRecord {
  destination_id: string;
  destination_ref: string;
  prior_destination_refs: string[];
  configuration: Json;
  proof_tuple: string;
  /** Set when the current generation first became active. */
  proof_started_at?: string;
}

interface RetiredRecord {
  destination_id: string;
  destination_refs: string[];
  revoked_at: string;
}

interface PrincipalDocument extends Json {
  revision: number;
  destinations: DestinationRecord[];
  retired: RetiredRecord[];
  declared: Json;
}

interface Caller {
  key: string;
  principalId: string;
  kind: PrincipalKind;
}

interface PrincipalError {
  code: string;
  message: string;
  recovery: 'correctable';
  field?: string;
}

class SectionRejection extends Error {
  constructor(readonly error: PrincipalError) {
    super(error.message);
  }
}

function reject(code: string, message: string, field?: string): never {
  throw new SectionRejection({ code, message, recovery: 'correctable', ...(field && { field }) });
}

const IDENTITY_BODY_FIELDS = ['buyer_agent_url', 'agent_url', 'principal_id', 'connection_id'] as const;

function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  parts.forEach((part, index) => hash.update(index === 0 ? part : `\0${part}`));
  return hash.digest('hex');
}

/** Per-user (WorkOS user) identities are operators; every other authenticated
 * credential in the training agent is a workload API key, i.e. a buyer agent. */
export function principalKindFor(trainingCtx: Pick<TrainingContext, 'principal'>): PrincipalKind {
  return trainingCtx.principal?.startsWith('workos:user_') ? 'operator' : 'buyer_agent';
}

function resolveCaller(trainingCtx: TrainingContext): Caller | undefined {
  const key = trainingCallerPrincipal(trainingCtx);
  if (!key) return undefined;
  return {
    key,
    // Hashed so the principal record id never embeds a credential or key id.
    principalId: `prin_${sha256(TENANT_ID, key).slice(0, 26).toUpperCase()}`,
    kind: principalKindFor(trainingCtx),
  };
}

function authRequired(task: string): Json {
  return {
    errors: [{
      code: 'AUTH_REQUIRED',
      message: `${task} requires an authenticated caller principal`,
      recovery: 'correctable',
    }],
  };
}

function failed(errors: PrincipalError[]): Json {
  return { status: 'failed', result: { kind: 'failed', errors } };
}

function suppliedIdentityField(args: ToolArgs): string | undefined {
  return IDENTITY_BODY_FIELDS.find(field => Object.prototype.hasOwnProperty.call(args, field));
}

// ── Reporting destinations ──────────────────────────────────────────

/** None of the offered transports (s3, gcs, bigquery, snowflake) uses a
 * userinfo authority, so any `@` before the first path separator is treated as
 * an embedded credential (`key:secret@host`, access-key ids). The schema
 * pattern already bars whitespace, query, fragment, and percent-encoding. */
function carriesSecret(location: string): boolean {
  const authority = location.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '').split('/')[0] ?? '';
  return authority.includes('@');
}

function normalizeLocation(location: string): string {
  const nfc = location.normalize('NFC');
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(nfc);
  if (!match) return nfc;
  const [, scheme, authority = '', path = ''] = match;
  if (!/^[\x21-\x7e]*$/.test(authority)) {
    reject('INVALID_REQUEST', 'destination location host authority must be ASCII', 'reporting_destinations');
  }
  return `${scheme!.toLowerCase()}://${authority.toLowerCase()}${path.replace(/\/{2,}/g, '/')}`;
}

function offeringFor(pattern: unknown): Offering | undefined {
  return PRINCIPAL_CAPABILITY.reporting_destination_offerings.find(offering => offering.pattern === pattern);
}

function normalizeDestination(destination: Json): Json {
  const destinationId = String(destination.destination_id);
  const offering = offeringFor(destination.pattern);
  const outOfOffering = (detail: string): never =>
    reject('UNSUPPORTED_FEATURE', `destination ${destinationId} is outside the advertised offering: ${detail}`, 'reporting_destinations');
  if (!offering) return outOfOffering(`pattern ${String(destination.pattern)}`);
  if (!(offering.transports as readonly string[]).includes(String(destination.transport))) {
    outOfOffering(`transport ${String(destination.transport)}`);
  }
  const formats = destination.accepted_formats as string[] | undefined;
  if (formats && 'formats' in offering && !formats.some(format => (offering.formats as readonly string[]).includes(format))) {
    outOfOffering('no accepted format is produced by this seller');
  }
  const profiles = destination.accepted_verification_profiles as string[];
  if (!profiles.some(profile => (offering.verification_profiles as readonly string[]).includes(profile))) {
    outOfOffering('no accepted verification profile is produced by this seller');
  }
  const location = normalizeLocation(String(destination.location));
  if (carriesSecret(location)) {
    reject('INVALID_REQUEST', `destination ${destinationId} location must not carry credentials`, 'reporting_destinations');
  }
  return { ...structuredClone(destination), location };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Json)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function proofTuple(configuration: Json): string {
  // Everything that changes where or how delivery lands. `active` and
  // `operator_id` are bookkeeping and never force a new generation. Set-valued
  // arrays are order-insensitive.
  const { active: _active, operator_id: _operator, ...bound } = configuration;
  const unordered = Object.fromEntries(
    Object.entries(bound).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
  );
  return sha256(canonicalJson(unordered));
}

function newRef(): string {
  return `dest_${randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`;
}

function applyDestinations(
  prior: PrincipalDocument,
  desired: Json[],
  nowIso: string,
): { destinations: DestinationRecord[]; retired: RetiredRecord[] } {
  if (desired.length > PRINCIPAL_CAPABILITY.max_reporting_destinations) {
    reject('INVALID_REQUEST', `reporting_destinations accepts at most ${PRINCIPAL_CAPABILITY.max_reporting_destinations} destinations`, 'reporting_destinations');
  }
  const seen = new Set<string>();
  const normalized = desired.map(destination => {
    const id = String(destination.destination_id);
    if (seen.has(id)) reject('INVALID_REQUEST', `duplicate destination_id: ${id}`, 'reporting_destinations');
    seen.add(id);
    return normalizeDestination(destination);
  });
  const priorById = new Map(prior.destinations.map(record => [record.destination_id, record]));
  const destinations = normalized.map((configuration): DestinationRecord => {
    const id = String(configuration.destination_id);
    const tuple = proofTuple(configuration);
    const existing = priorById.get(id);
    const active = configuration.active === true;
    if (existing && existing.proof_tuple === tuple) {
      return {
        ...existing,
        configuration,
        ...(active && !existing.proof_started_at && { proof_started_at: nowIso }),
      };
    }
    return {
      destination_id: id,
      destination_ref: newRef(),
      prior_destination_refs: existing
        ? [existing.destination_ref, ...existing.prior_destination_refs].slice(0, MAX_GENERATION_REFS)
        : [],
      configuration,
      proof_tuple: tuple,
      ...(active && { proof_started_at: nowIso }),
    };
  });
  const retiredById = new Map(prior.retired.map(record => [record.destination_id, record]));
  for (const record of prior.destinations) {
    if (seen.has(record.destination_id)) continue;
    const refs = [record.destination_ref, ...record.prior_destination_refs];
    const earlier = retiredById.get(record.destination_id);
    retiredById.set(record.destination_id, {
      destination_id: record.destination_id,
      destination_refs: [...refs, ...(earlier?.destination_refs ?? [])].slice(0, MAX_GENERATION_REFS),
      revoked_at: nowIso,
    });
  }
  const retired = [...retiredById.values()]
    .sort((a, b) => b.revoked_at.localeCompare(a.revoked_at))
    .slice(0, MAX_RETIRED_DESTINATIONS);
  return { destinations, retired };
}

function destinationState(record: DestinationRecord, now: number): Json {
  const configuration = record.configuration;
  const base: Json = {
    destination_id: record.destination_id,
    destination_ref: record.destination_ref,
    ...(record.prior_destination_refs.length > 0 && { prior_destination_refs: record.prior_destination_refs }),
    configuration,
  };
  if (configuration.active !== true) return { ...base, state: 'inactive' };
  const started = Date.parse(record.proof_started_at ?? '') || now;
  if (now - started >= DESTINATION_PROOF_DELAY_MS) return { ...base, state: 'ready' };
  return {
    ...base,
    state: 'action_required',
    setup: {
      action: 'prove_control',
      expires_at: new Date(started + SETUP_ACTION_TTL_MS).toISOString(),
    },
  };
}

// ── Declarations ────────────────────────────────────────────────────

function selectedVersion(versions: string[]): string | undefined {
  const parsed = (version: string) => version.split('.').map(Number) as [number, number];
  return [...versions].sort((a, b) => {
    const [aMajor, aMinor] = parsed(a);
    const [bMajor, bMinor] = parsed(b);
    return bMajor - aMajor || bMinor - aMinor;
  })[0];
}

function declarationsState(declared: Json): Json {
  const accepted: Json = {};
  const exclusions: Array<{ axis: string; value: string; reason: string }> = [];
  const axes: Array<[string, readonly string[], string]> = [
    ['async_adcp_versions', SELLER_ASYNC_ADCP_VERSIONS, 'not an AdCP minor version this seller emits asynchronous payloads for'],
    ['webhook_signing_algorithms', SELLER_WEBHOOK_SIGNING_ALGORITHMS, 'not a webhook signing algorithm this seller supports'],
    ['experimental_features', SELLER_ASYNC_EXPERIMENTAL_FEATURES, 'not an experimental feature this seller emits in asynchronous payloads'],
  ];
  for (const [axis, supported, reason] of axes) {
    const values = declared[axis] as string[] | undefined;
    if (!values) continue;
    const kept = values.filter(value => supported.includes(value));
    if (kept.length > 0) accepted[axis] = kept;
    for (const value of values) {
      if (!supported.includes(value)) exclusions.push({ axis, value, reason });
    }
  }
  const selected = selectedVersion((accepted.async_adcp_versions as string[] | undefined) ?? []);
  return {
    declared,
    accepted,
    ...(selected && { selected_async_adcp_version: selected }),
    ...(exclusions.length > 0 && { exclusions }),
  };
}

// ── Persistence ─────────────────────────────────────────────────────

function emptyDocument(): PrincipalDocument {
  return { revision: 0, destinations: [], retired: [], declared: {} };
}

interface Loaded {
  session: SessionState;
  caller: Caller;
  document: PrincipalDocument | undefined;
  /** Whether the caller has an active capability-change subscriber registered
   * through `sync_agent_notification_configs`. */
  hasActiveSubscriber: boolean;
}

async function load(trainingCtx: TrainingContext, caller: Caller): Promise<Loaded> {
  const session = await getSession(sessionKeyFromArgs(
    {},
    trainingCtx.mode,
    trainingCtx.userId,
    trainingCtx.moduleId,
    caller.key,
  ));
  const subscribers = session.agentNotificationConfigs.get(
    agentNotificationDocumentId({ tenant_id: TENANT_ID, principal_id: caller.key }),
  ) as { notification_configs?: Array<{ active?: boolean }> } | undefined;
  return {
    session,
    caller,
    document: session.principalConfigurations.get(caller.key) as PrincipalDocument | undefined,
    hasActiveSubscriber: (subscribers?.notification_configs ?? []).some(config => config.active !== false),
  };
}

function configurationVersion(document: PrincipalDocument): string {
  // Seller-driven setup transitions (action_required -> ready) are computed at
  // read time and are deliberately not inputs.
  return `cfg_${sha256(String(document.revision)).slice(0, 26).toUpperCase()}`;
}

function principalState(document: PrincipalDocument, now: number): Json {
  return {
    reporting_destinations: document.destinations.map(record => destinationState(record, now)),
    declarations: declarationsState(document.declared),
    ...(document.retired.length > 0 && { retired_destinations: document.retired }),
  };
}

// ── get_principal ───────────────────────────────────────────────────

export async function getPrincipalLegacy(
  args: ToolArgs,
  trainingCtx: TrainingContext,
  now: () => number = Date.now,
): Promise<Json> {
  const caller = resolveCaller(trainingCtx);
  if (!caller) return authRequired('get_principal');
  if (suppliedIdentityField(args)) {
    return failed([{
      code: 'INVALID_REQUEST',
      message: 'get_principal resolves identity from authenticated transport; identity fields are not accepted',
      recovery: 'correctable',
    }]);
  }
  const { document } = await load(trainingCtx, caller);
  if (!document) {
    return {
      status: 'completed',
      result: { kind: 'recognized', principal_id: caller.principalId, principal_kind: caller.kind },
    };
  }
  return {
    status: 'completed',
    result: {
      kind: 'current',
      principal_id: caller.principalId,
      principal_kind: caller.kind,
      configuration_version: configurationVersion(document),
      configuration: principalState(document, now()),
    },
  };
}

// ── sync_principal ──────────────────────────────────────────────────

interface SyncRequest {
  expected_configuration_version?: string;
  expected_principal_kind?: string;
  configuration: {
    notification_configs?: Json[];
    reporting_destinations?: Json[];
    declarations?: Json;
  };
  dry_run?: boolean;
}

function isEmptySection(section: unknown): boolean {
  return Array.isArray(section) ? section.length === 0 : Object.keys(section as Json).length === 0;
}

function requireSignableWebhooks(declared: Json, hasActiveSubscriber: boolean): void {
  const algorithms = declared.webhook_signing_algorithms as string[] | undefined;
  if (!hasActiveSubscriber || !algorithms) return;
  if (!algorithms.some(algorithm => SELLER_WEBHOOK_SIGNING_ALGORITHMS.includes(algorithm))) {
    reject(
      'UNSUPPORTED_FEATURE',
      'declared webhook_signing_algorithms share no algorithm with this seller while a webhook subscriber is active',
      'configuration.declarations.webhook_signing_algorithms',
    );
  }
}

function validateRequest(request: SyncRequest): void {
  const validation = validateSourceSchema('protocol/sync-principal-request.json', request);
  if (!validation.valid) {
    const first = validation.errors[0];
    const path = first?.instancePath.replace(/^\//, '').replaceAll('/', '.');
    reject('INVALID_REQUEST', `request does not match sync-principal-request.json: ${first?.message ?? 'invalid'}`, path || undefined);
  }
  const unsupported = Object.keys(request.configuration).filter(
    section => !(PRINCIPAL_SECTIONS as readonly string[]).includes(section),
  );
  if (unsupported.length > 0) {
    reject('UNSUPPORTED_FEATURE', `unsupported configuration section: ${unsupported.join(', ')}`, `configuration.${unsupported[0]}`);
  }
}

export async function syncPrincipalLegacy(
  args: ToolArgs,
  trainingCtx: TrainingContext,
  now: () => number = Date.now,
): Promise<Json> {
  const caller = resolveCaller(trainingCtx);
  if (!caller) return authRequired('sync_principal');
  if (suppliedIdentityField(args)) {
    return failed([{
      code: 'INVALID_REQUEST',
      message: 'sync_principal resolves identity from authenticated transport; identity fields are not accepted',
      recovery: 'correctable',
    }]);
  }
  const request = args as unknown as SyncRequest;
  const loaded = await load(trainingCtx, caller);
  const prior = loaded.document ?? emptyDocument();
  const nowIso = new Date(now()).toISOString();

  if (request.expected_principal_kind !== undefined && request.expected_principal_kind !== caller.kind) {
    return failed([{
      code: 'CONFLICT',
      message: 'expected_principal_kind does not match the authenticated principal kind',
      recovery: 'correctable',
      field: 'expected_principal_kind',
    }]);
  }
  if (request.expected_configuration_version !== undefined
    && (!loaded.document || request.expected_configuration_version !== configurationVersion(loaded.document))) {
    return failed([{
      code: 'CONFLICT',
      message: 'expected_configuration_version is stale; re-read with get_principal',
      recovery: 'correctable',
      field: 'expected_configuration_version',
    }]);
  }

  // Validate every section before anything is written, so a rejection leaves
  // all prior sections unchanged.
  const submitted = request.configuration;
  let next: PrincipalDocument = structuredClone(prior);
  try {
    validateRequest(request);
    if (submitted.reporting_destinations !== undefined) {
      const { destinations, retired } = applyDestinations(prior, submitted.reporting_destinations, nowIso);
      next = { ...next, destinations, retired };
    }
    if (submitted.declarations !== undefined) {
      next = { ...next, declared: structuredClone(submitted.declarations) };
    }
    requireSignableWebhooks(next.declared, loaded.hasActiveSubscriber);
  } catch (error) {
    if (error instanceof SectionRejection) return failed([error.error]);
    throw error;
  }

  const sectionChanged: boolean[] = [];
  const emptied: boolean[] = [];
  if (submitted.reporting_destinations !== undefined) {
    // A new generation (destination_ref) counts as a change even when the
    // submitted configuration is byte-identical.
    const view = (record: DestinationRecord) => [
      record.destination_ref,
      proofTuple(record.configuration),
      record.configuration.active,
      record.configuration.operator_id,
    ];
    sectionChanged.push(!isDeepStrictEqual(prior.destinations.map(view), next.destinations.map(view)));
    emptied.push(isEmptySection(submitted.reporting_destinations));
  }
  if (submitted.declarations !== undefined) {
    const asSets = (declared: Json) => Object.fromEntries(
      Object.entries(declared).map(([axis, values]) => [axis, [...(values as string[])].sort()]),
    );
    sectionChanged.push(!isDeepStrictEqual(asSets(prior.declared), asSets(next.declared)));
    emptied.push(isEmptySection(submitted.declarations));
  }
  const changed = sectionChanged.some(Boolean);

  if (request.dry_run) {
    return {
      status: 'completed',
      result: {
        kind: 'validated',
        dry_run: true,
        action: !changed ? 'would_be_unchanged' : emptied.every(Boolean) ? 'would_clear' : 'would_update',
      },
    };
  }

  // Unchanged against a principal with no record still materializes the empty
  // record, so the applied response and a later read describe the same state.
  const document: PrincipalDocument = changed ? { ...next, revision: next.revision + 1 } : prior;
  if (changed || !loaded.document) {
    loaded.session.principalConfigurations.set(caller.key, structuredClone(document));
  }
  return {
    status: 'completed',
    result: {
      kind: 'applied',
      action: !changed ? 'unchanged' : emptied.every(Boolean) ? 'cleared' : 'updated',
      dry_run: false,
      principal_id: caller.principalId,
      principal_kind: caller.kind,
      configuration_version: configurationVersion(document),
      configuration: principalState(document, now()),
    },
  };
}
