/**
 * Experimental AdCP 3.3 holds on the training agent (#8181):
 *
 * - `media_buy.hold_policy`: product planning hints, the binding policy on
 *   drafts, and committed proposals carrying it forward with `hold_placed_at`
 *   inside the policy's bounds (refine_proposals.mdx, "Hold policy").
 * - `media_buy.hold_extension`: `extend_hold` ("Extend a hold").
 * - `media_buy.hold_ranking`: ranked holds and `hold_rank` ("Hold ranking").
 * - `media_buy.installment_holds`: `holds[]` on committed proposals
 *   ("Installment holds").
 *
 * These wrap the compact lifecycle handlers on the sales tenant's default
 * routes. Fields are served only to callers whose served version is 3.3 (the
 * opt-in `3.3-beta.3` preview pin, or candidate mode); other callers see the
 * engine exactly as before, except that a draft served to a 3.3 caller with a
 * terms-only policy is never committed for a caller below 3.3.
 *
 * Times follow the caller's sandbox clock (account-sandbox.ts): the wall
 * clock until a storyboard moves it.
 *
 * Policies come from the catalog fixtures (fixtures.ts) and from products a
 * storyboard seeded through comply_test_controller with a `hold_policy`, so a
 * seller-agnostic storyboard can declare the policies it tests.
 */

import { createHash } from 'node:crypto';
import { callerSandboxNowMs } from '../account-sandbox.js';
import { getIdempotencyStore } from '../idempotency.js';
import { getSession, flushDirtySessions, sessionKeyFromArgs } from '../state.js';
import {
  compactCatalogProduct,
  compactProposalOutward,
  compactProposalSessionKey,
  withCompactProposalSessionLock,
} from '../task-handlers.js';
import { atLeastAdcpVersion, type SessionState, type TrainingContext } from '../types.js';
import { runWithHoldPlan } from './context.js';
import { holdFixture, runWithSeededHoldFixtures, seededHoldFixture, type HoldFixture } from './fixtures.js';
import { AGENT_DEFAULT_POLICY, deriveDraftPolicy, durationMs, type HoldPolicy } from './policy.js';
import {
  draftPolicyRecord,
  holdRecord,
  loadHoldDocument,
  occupiesSlots,
  positionOn,
  saveHoldDocument,
  type HoldDocument,
  type HoldRecord,
  type InstallmentHoldEntry,
} from './store.js';

export const HOLD_POLICY_FEATURE = 'media_buy.hold_policy';
export const HOLD_EXTENSION_FEATURE = 'media_buy.hold_extension';
export const HOLD_RANKING_FEATURE = 'media_buy.hold_ranking';
export const INSTALLMENT_HOLDS_FEATURE = 'media_buy.installment_holds';
export const HOLD_FEATURES = [
  HOLD_POLICY_FEATURE,
  HOLD_EXTENSION_FEATURE,
  HOLD_RANKING_FEATURE,
  INSTALLMENT_HOLDS_FEATURE,
] as const;
export const FORCE_HOLD_UNAVAILABLE = 'force_hold_unavailable';

/** First wire checkpoint carrying the hold surfaces. */
export const HOLDS_ADCP_VERSION = '3.3-beta' as const;

/** The hold window when a policy declares no maximum, as before 3.3. */
const DEFAULT_HOLD_MS = 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;
type Errors = { errors: Array<{ code: string; message: string; field?: string; recovery?: string }> };

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function taskError(code: string, message: string, field?: string, recovery = 'correctable'): Errors {
  return { errors: [{ code, message, ...(field && { field }), recovery }] };
}

function hasErrors(result: unknown): result is Errors {
  return isRecord(result) && Array.isArray(result.errors) && result.errors.length > 0;
}

/** Whether the served release carries the hold surfaces at all. */
export function supportsHolds33(servedVersion: string | undefined): boolean {
  return atLeastAdcpVersion(servedVersion, HOLDS_ADCP_VERSION);
}

/**
 * Whether this request is served holds: a 3.3 caller on a route whose
 * refinement runs through this module (not the typed-negotiation lab
 * profiles, whose SDK engine does not place holds).
 */
export function holdsServed(ctx: Pick<TrainingContext, 'servedAdcpVersion' | 'proposalNegotiationProfile' | 'storyboardCompat'>): boolean {
  return supportsHolds33(ctx.servedAdcpVersion)
    && (!ctx.proposalNegotiationProfile || ctx.proposalNegotiationProfile === 'ask-only')
    && ctx.storyboardCompat?.version !== '3.0';
}

// ── Policies ─────────────────────────────────────────────────────

/** A product's planning hint, when it declares one. */
export function productHoldPolicy(productId: string): HoldPolicy | undefined {
  const fixture = holdFixture(productId);
  return fixture ? structuredClone(fixture.policy) : undefined;
}

function effectiveProductPolicy(productId: string): HoldPolicy {
  return productHoldPolicy(productId) ?? { ...AGENT_DEFAULT_POLICY };
}

function purchasesOf(proposal: Json): Json[] {
  const terms = isRecord(proposal.commercial_terms) ? proposal.commercial_terms : undefined;
  return Array.isArray(terms?.purchases) ? terms.purchases.filter(isRecord) : [];
}

function productIdsOf(proposal: Json): string[] {
  return [...new Set(purchasesOf(proposal)
    .map(purchase => purchase.product_id)
    .filter((id): id is string => typeof id === 'string'))];
}

/** The draft's binding policy: as first served, or derived now. */
function draftPolicy(doc: HoldDocument, draft: Json): HoldPolicy {
  const id = typeof draft.proposal_id === 'string' ? draft.proposal_id : '';
  return draftPolicyRecord(doc, id) ?? deriveDraftPolicy(productIdsOf(draft).map(effectiveProductPolicy));
}

/** Record the binding policy of every draft served now, once. */
function recordDraftPolicies(doc: HoldDocument, proposals: Json[]): boolean {
  let changed = false;
  for (const proposal of proposals) {
    if (proposal.proposal_status !== 'draft' || typeof proposal.proposal_id !== 'string') continue;
    if (draftPolicyRecord(doc, proposal.proposal_id)) continue;
    doc.drafts.push({ proposal_id: proposal.proposal_id, policy: draftPolicy(doc, proposal) });
    changed = true;
  }
  return changed;
}

// ── Response decoration ──────────────────────────────────────────

/** Add each fixture product's planning hint. A `fields` projection that
 * leaves out `hold_policy` is respected. */
function decorateProducts(products: unknown, requestedFields?: ReadonlySet<string>): void {
  if (!Array.isArray(products)) return;
  if (requestedFields && !requestedFields.has('hold_policy')) return;
  for (const product of products) {
    if (!isRecord(product) || typeof product.product_id !== 'string') continue;
    const policy = productHoldPolicy(product.product_id);
    if (policy) product.hold_policy = policy;
  }
}

/** The 3.3 hold fields of a committed proposal the ledger tracks. */
function committedHoldFields(record: HoldRecord): Json {
  return {
    hold_policy: structuredClone(record.policy),
    ...(record.placed_at && { hold_placed_at: record.placed_at }),
    ...(record.placed_at && record.policy.rankable === true && record.rank !== undefined && { hold_rank: record.rank }),
    ...(record.placed_at && record.holds && record.holds.length > 0 && { holds: structuredClone(record.holds) }),
  };
}

function decorateProposal(doc: HoldDocument, proposal: Json): void {
  if (typeof proposal.proposal_id !== 'string') return;
  if (proposal.proposal_status === 'draft') {
    proposal.hold_policy = draftPolicy(doc, proposal);
    return;
  }
  if (proposal.proposal_status !== 'committed') return;
  // A committed proposal the ledger does not track (finalized for a caller
  // below 3.3) is left as it is: hold_policy available true would require a
  // hold_placed_at the seller never recorded.
  const record = holdRecord(doc, proposal.proposal_id);
  if (record) Object.assign(proposal, committedHoldFields(record));
}

function decorateRefineResponse(doc: HoldDocument, response: Json): void {
  for (const result of Array.isArray(response.results) ? response.results.filter(isRecord) : []) {
    if (isRecord(result.proposal)) decorateProposal(doc, result.proposal);
    for (const proposal of Array.isArray(result.proposals) ? result.proposals.filter(isRecord) : []) {
      decorateProposal(doc, proposal);
    }
  }
  decorateProducts(response.products);
}

const queues = new Map<string, Promise<unknown>>();
const HOLDS_LOCK_PRINCIPAL = 'holds-ledger-mutex';
const HOLDS_LOCK_WAIT_MS = 5_000;

/**
 * Run hold writes for one caller one at a time, so two concurrent finalizes
 * on the same inventory get distinct positions. An in-process queue orders
 * this machine's requests; a claim in the shared idempotency store (Postgres
 * when the agent runs on several machines) orders them across machines. The
 * claim is separate from the proposal engine's session mutex, which a
 * finalize takes inside it, so the order is always ledger, then engine.
 */
async function serialized<T>(ctx: TrainingContext, fn: () => Promise<T>): Promise<T | Errors> {
  const sessionKey = compactProposalSessionKey(ctx);
  const previous = queues.get(sessionKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withLedgerClaim(sessionKey, fn));
  const tail = run.catch(() => undefined);
  queues.set(sessionKey, tail);
  try {
    return await run;
  } finally {
    if (queues.get(sessionKey) === tail) queues.delete(sessionKey);
  }
}

async function withLedgerClaim<T>(sessionKey: string, fn: () => Promise<T>): Promise<T | Errors> {
  const hash = createHash('sha256').update(sessionKey).digest('hex');
  const key = `holds-ledger:${hash}`;
  const store = getIdempotencyStore();
  const deadline = Date.now() + HOLDS_LOCK_WAIT_MS;
  let backoff = 10;
  let claim = await store.check({ principal: HOLDS_LOCK_PRINCIPAL, key, payload: { session: hash } });
  while (claim.kind !== 'miss' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 250);
    claim = await store.check({ principal: HOLDS_LOCK_PRINCIPAL, key, payload: { session: hash } });
  }
  if (claim.kind !== 'miss') {
    return taskError('CONFLICT', 'Another hold request is updating this sandbox. Retry shortly.', undefined, 'transient');
  }
  try {
    return await fn();
  } finally {
    await store.release({ principal: HOLDS_LOCK_PRINCIPAL, key, claimToken: claim.claimToken });
  }
}

async function sessionAndDoc(ctx: TrainingContext): Promise<{ session: SessionState; doc: HoldDocument }> {
  const session = await getSession(compactProposalSessionKey(ctx));
  return { session, doc: loadHoldDocument(session) };
}

async function sandboxNow(ctx: TrainingContext): Promise<number> {
  return callerSandboxNowMs(ctx.principal);
}

/**
 * Run `fn` with the hold policies of the caller's seeded products in scope.
 * A storyboard seeds products into its account's fixture session, and the
 * compact_product_lifecycle_probe `prepare` operation promotes them into the
 * caller's principal partition, which the compact proposal engine reads; both
 * partitions are consulted, the compact one last so it wins.
 */
async function withSeededHoldPolicies<T>(ctx: TrainingContext, fn: () => Promise<T>): Promise<T> {
  const partitions = [
    sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, ctx.principal ?? 'anonymous'),
    compactProposalSessionKey(ctx),
  ];
  const seeded = new Map<string, HoldFixture>();
  for (const key of new Set(partitions)) {
    const session = await getSession(key);
    for (const [productId, product] of session.complyExtensions.seededProducts) {
      const fixture = seededHoldFixture(product);
      if (fixture) seeded.set(productId, fixture);
    }
  }
  return runWithSeededHoldFixtures(seeded, fn);
}

// ── list_products and request_proposals ─────────────────────────

export async function withHoldsListProducts(
  args: Json,
  ctx: TrainingContext,
  inner: () => Promise<Json>,
): Promise<Json> {
  const result = await inner();
  if (!holdsServed(ctx) || hasErrors(result)) return result;
  return withSeededHoldPolicies(ctx, async () => decorateListedProducts(args, result));
}

function decorateListedProducts(args: Json, result: Json): Json {
  const fields = Array.isArray(args.fields)
    ? new Set(args.fields.filter((field): field is string => typeof field === 'string'))
    : undefined;
  decorateProducts(result.products, fields);
  return result;
}

export async function withHoldsRequestProposals(
  _args: Json,
  ctx: TrainingContext,
  inner: () => Promise<Json>,
): Promise<Json> {
  if (!holdsServed(ctx)) return inner();
  return withSeededHoldPolicies(ctx, () => requestProposalsWithPolicies(ctx, inner));
}

async function requestProposalsWithPolicies(ctx: TrainingContext, inner: () => Promise<Json>): Promise<Json> {
  const result = await runWithHoldPlan({ installmentFlights: true }, inner);
  if (hasErrors(result) || !Array.isArray(result.proposals)) return result;
  const { session, doc } = await sessionAndDoc(ctx);
  const proposals = result.proposals.filter(isRecord);
  if (recordDraftPolicies(doc, proposals)) {
    saveHoldDocument(session, doc, await sandboxNow(ctx));
    await flushDirtySessions();
  }
  for (const proposal of proposals) decorateProposal(doc, proposal);
  decorateProducts(result.products);
  return result;
}

// ── decline_proposals ───────────────────────────────────────────

export async function withHoldsDeclineProposals(
  _args: Json,
  ctx: TrainingContext,
  inner: () => Promise<Json>,
): Promise<Json> {
  return serialized(ctx, () => declineReleasingHolds(ctx, inner));
}

async function declineReleasingHolds(ctx: TrainingContext, inner: () => Promise<Json>): Promise<Json> {
  const result = await inner();
  if (hasErrors(result) || !Array.isArray(result.results)) return result;
  const declined = result.results.filter(isRecord)
    .filter(entry => entry.outcome === 'declined' && typeof entry.proposal_id === 'string')
    .map(entry => entry.proposal_id as string);
  if (declined.length === 0) return result;
  const { session, doc } = await sessionAndDoc(ctx);
  let changed = false;
  for (const record of doc.holds) {
    if (record.state === 'live' && declined.includes(record.proposal_id)) {
      // Declining a committed proposal releases its hold: holds behind it move up.
      record.state = 'released';
      changed = true;
    }
  }
  if (changed) {
    saveHoldDocument(session, doc, await sandboxNow(ctx));
    await flushDirtySessions();
  }
  return result;
}

// ── accept_proposal ─────────────────────────────────────────────

export async function withHoldsAcceptProposal(
  args: Json,
  ctx: TrainingContext,
  inner: () => Promise<Json>,
): Promise<Json> {
  return serialized(ctx, () => acceptConsumingHold(args, ctx, inner));
}

async function acceptConsumingHold(args: Json, ctx: TrainingContext, inner: () => Promise<Json>): Promise<Json> {
  const proposalId = typeof args.proposal_id === 'string' ? args.proposal_id : undefined;
  if (!proposalId) return inner();
  const { doc } = await sessionAndDoc(ctx);
  const record = holdRecord(doc, proposalId);
  if (!record) return inner();
  if (record.state === 'superseded') {
    return taskError(
      'INVALID_STATE',
      `Proposal ${proposalId} was superseded when its hold was extended; accept the extension's committed successor instead.`,
      'proposal_id',
    );
  }
  if (record.state === 'live' && record.placed_at) {
    const now = await sandboxNow(ctx);
    if (Date.parse(record.expires_at) <= now) {
      return taskError(
        'PROPOSAL_EXPIRED',
        `Proposal ${proposalId} expired at ${record.expires_at}. Request and finalize a fresh proposal before retrying.`,
        'proposal_id',
      );
    }
    if (record.policy.rankable === true && currentRank(doc, record, now) > 1) {
      // Only the fact that a hold ahead stands is disclosed: no identity,
      // terms, or expiry of any other hold.
      return taskError(
        'PRODUCT_UNAVAILABLE',
        `A hold ahead of proposal ${proposalId} still stands on the inventory it holds. The proposal stays committed until its expires_at; a later acceptance may succeed.`,
        'proposal_id',
      );
    }
  }
  const result = await inner();
  if (hasErrors(result) || record.state !== 'live') return result;
  // The booking consumes the hold.
  const { session, doc: current } = await sessionAndDoc(ctx);
  const booked = holdRecord(current, proposalId);
  if (booked?.state === 'live') {
    booked.state = 'accepted';
    saveHoldDocument(session, current, await sandboxNow(ctx));
    await flushDirtySessions();
  }
  return result;
}

/** The record's position now: 1 + live or booked holds queued ahead of it on
 * any of its slots. Never worse than when it was placed. */
function currentRank(doc: HoldDocument, record: HoldRecord, nowMs: number): number {
  return Math.max(1, ...record.slots.map(slot => positionOn(doc, slot, record.seq, nowMs)));
}

// ── refine_proposals ────────────────────────────────────────────

interface Installment {
  installment_id?: unknown;
  collection_ref?: unknown;
  scheduled_at?: unknown;
  deadlines?: { booking_deadline?: unknown; change_cutoff?: unknown };
}

function installmentsOf(productId: string): Installment[] {
  const product = compactCatalogProduct(productId) as unknown as { installments?: unknown } | undefined;
  return Array.isArray(product?.installments) ? product.installments.filter(isRecord) as Installment[] : [];
}

/**
 * The earliest `booking_deadline` or `change_cutoff` across the installments
 * of the products a draft allocates: a hold never outlives it.
 */
function installmentDeadlineCap(productIds: readonly string[]): number | undefined {
  const instants = productIds.flatMap(installmentsOf)
    .flatMap(installment => [installment.deadlines?.booking_deadline, installment.deadlines?.change_cutoff])
    .filter((value): value is string => typeof value === 'string')
    .map(value => Date.parse(value))
    .filter(Number.isFinite);
  return instants.length > 0 ? Math.min(...instants) : undefined;
}

/** The installments a purchase holds: those its product includes that are
 * scheduled within the purchase's flight. */
function heldInstallments(purchase: Json): InstallmentHoldEntry[] {
  const productId = typeof purchase.product_id === 'string' ? purchase.product_id : undefined;
  const start = typeof purchase.start_time === 'string' ? Date.parse(purchase.start_time) : Number.NaN;
  const end = typeof purchase.end_time === 'string' ? Date.parse(purchase.end_time) : Number.NaN;
  if (!productId || !Number.isFinite(start) || !Number.isFinite(end)) return [];
  return installmentsOf(productId).flatMap(installment => {
    const at = typeof installment.scheduled_at === 'string' ? Date.parse(installment.scheduled_at) : Number.NaN;
    const ref = installment.collection_ref;
    if (!Number.isFinite(at) || at < start || at > end) return [];
    if (typeof installment.installment_id !== 'string' || !isRecord(ref)) return [];
    if (typeof ref.publisher_domain !== 'string' || typeof ref.collection_id !== 'string') return [];
    return [{
      product_id: productId,
      installment_ref: {
        collection_ref: { publisher_domain: ref.publisher_domain, collection_id: ref.collection_id },
        installment_id: installment.installment_id,
      },
    }];
  });
}

const installmentSlot = (entry: InstallmentHoldEntry) => (
  `i:${entry.product_id}#${entry.installment_ref.collection_ref.publisher_domain}/${entry.installment_ref.collection_ref.collection_id}/${entry.installment_ref.installment_id}`
);

interface PlacedHold {
  sourceId: string;
  policy: HoldPolicy;
  ownerAccountId?: string;
  placedAt?: string;
  expiresAt?: string;
  seq: number;
  slots: string[];
  rank?: number;
  holds?: InstallmentHoldEntry[];
}

type PlanFailure = 'forced' | 'contended' | 'minimum' | 'deadline';

const FAILURE_REASONS: Record<PlanFailure, string> = {
  forced: 'The seller could not reserve the inventory this draft allocates.',
  contended: 'The inventory this draft allocates is already held, and its hold policy allows only a first-position hold.',
  minimum: "The seller cannot honor the draft's minimum hold before the earliest booking deadline of the installments it allocates.",
  deadline: 'The booking deadline of the installments this draft allocates has passed, so no hold can be placed.',
};

/**
 * Place every hold of a finalize batch against a copy of the ledger, in
 * request order, or report which entries cannot be held. Nothing is written.
 */
function planFinalize(
  doc: HoldDocument,
  drafts: Array<{ id: string; proposal: Json; ownerAccountId?: string }>,
  nowMs: number,
): { placed: PlacedHold[] } | { failures: Map<string, PlanFailure> } {
  const working: HoldDocument = structuredClone(doc);
  const placed: PlacedHold[] = [];
  const failures = new Map<string, PlanFailure>();
  for (const { id, proposal, ownerAccountId } of drafts) {
    // Only 3.3 callers reach placement (stable callers keep the legacy
    // engine), so the draft's policy applies as served, rankable included.
    const policy = draftPolicy(doc, proposal);
    const seq = working.next_seq++;
    if (!policy.available) {
      placed.push({ sourceId: id, policy, ownerAccountId, seq, slots: [] });
      continue;
    }
    if (doc.forced.some(entry => entry.proposal_id === id)) {
      failures.set(id, 'forced');
      continue;
    }
    const productIds = productIdsOf(proposal);
    const cap = installmentDeadlineCap(productIds);
    const ceiling = policy.max_duration
      ? nowMs + durationMs(policy.max_duration)
      : nowMs + Math.max(DEFAULT_HOLD_MS, policy.min_duration ? durationMs(policy.min_duration) : 0);
    const expires = cap === undefined ? ceiling : Math.min(ceiling, cap);
    if (expires <= nowMs) {
      failures.set(id, 'deadline');
      continue;
    }
    if (policy.min_duration && nowMs + durationMs(policy.min_duration) > expires) {
      failures.set(id, 'minimum');
      continue;
    }
    const entries = purchasesOf(proposal).flatMap(heldInstallments);
    const slots: string[] = [];
    const positions = new Map<string, number>();
    for (const productId of productIds) {
      const fixture = holdFixture(productId);
      if (fixture?.contention === 'product') slots.push(`p:${productId}`);
    }
    for (const entry of entries) {
      if (holdFixture(entry.product_id)?.contention === 'installment') slots.push(installmentSlot(entry));
    }
    for (const slot of slots) positions.set(slot, positionOn(working, slot, seq, nowMs));
    const worst = Math.max(1, ...positions.values());
    if (worst > 1 && policy.rankable !== true) {
      failures.set(id, 'contended');
      continue;
    }
    const hold: PlacedHold = {
      sourceId: id,
      policy,
      ownerAccountId,
      placedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      seq,
      slots,
      ...(policy.rankable === true && { rank: worst }),
      ...(entries.length > 0 && {
        holds: entries.map(entry => ({
          ...entry,
          ...(policy.rankable === true && { hold_rank: positions.get(installmentSlot(entry)) ?? 1 }),
        })),
      }),
    };
    placed.push(hold);
    // Later entries in the same batch queue behind this one.
    working.holds.push({
      proposal_id: `pending:${id}`, draft_id: id, policy, placed_at: hold.placedAt,
      expires_at: hold.expiresAt!, seq, slots, state: 'live',
    });
  }
  return failures.size > 0 ? { failures } : { placed };
}

/** The canonical products a refine response lists, from the catalog. */
function productsFor(proposals: Json[]): Json[] {
  const ids = [...new Set(proposals.flatMap(productIdsOf))];
  return ids.map(id => {
    const product = compactCatalogProduct(id) as unknown as { name?: unknown } | undefined;
    return { product_id: id, name: typeof product?.name === 'string' ? product.name : id };
  });
}

function batchFailureResponse(
  sourceIds: string[],
  failures: ReadonlyMap<string, { reason_code: string; reason: string }>,
  products: Json[],
): Json {
  return {
    results: sourceIds.map(sourceId => {
      const failure = failures.get(sourceId);
      return failure
        ? { source_proposal_id: sourceId, outcome: 'unable', reason_code: failure.reason_code, reason: failure.reason }
        : {
            source_proposal_id: sourceId,
            outcome: 'unable',
            reason_code: 'batch_aborted',
            reason: 'Not committed because another entry in this all-or-none batch failed.',
          };
    }),
    products,
  };
}

interface ResolvedDraft {
  id: string;
  proposal: Json;
  ownerAccountId?: string;
}

/**
 * The batch's drafts, when every entry is a draft the engine will finalize.
 * Otherwise undefined: the engine answers with its own task-level error.
 */
function resolveFinalizeDrafts(session: SessionState, sourceIds: string[]): ResolvedDraft[] | undefined {
  const internals = new Map((session.lastGetProductsContext?.proposals ?? [])
    .map(proposal => [proposal.proposal_id, proposal as unknown as Json]));
  const drafts: ResolvedDraft[] = [];
  for (const id of sourceIds) {
    const record = session.proposalRefinementRecords.get(id);
    const internal = internals.get(id);
    if (!record || !internal || record.declined || record.accepted) return undefined;
    if (internal.__declined === true || internal.__executed === true) return undefined;
    if (session.proposalLifecycleLinks.has(id)) return undefined;
    const proposal = record.proposal as unknown as Json;
    if (proposal.proposal_status !== 'draft') return undefined;
    if (typeof proposal.expires_at === 'string' && Date.parse(proposal.expires_at) < Date.now()) return undefined;
    drafts.push({ id, proposal, ...(record.ownerAccountId && { ownerAccountId: record.ownerAccountId }) });
  }
  return drafts;
}

export async function withHoldsRefineProposals(
  args: Json,
  ctx: TrainingContext,
  inner: () => Promise<Json>,
): Promise<Json> {
  if (!holdsServed(ctx)) return refineWithPolicies(args, ctx, inner);
  return withSeededHoldPolicies(ctx, () => refineWithPolicies(args, ctx, inner));
}

async function refineWithPolicies(
  args: Json,
  ctx: TrainingContext,
  inner: () => Promise<Json>,
): Promise<Json> {
  const refinements = Array.isArray(args.refinements) ? args.refinements.filter(isRecord) : [];
  const actions = new Set(refinements.map(entry => entry.action));
  const served = holdsServed(ctx);
  if (actions.has('extend_hold')) {
    if (!served) {
      // The action is the experimental hold_extension feature, which only
      // 3.3 callers are offered.
      return taskError('VALIDATION_ERROR', 'action extend_hold is not supported for this AdCP version.', 'refinements');
    }
    if (actions.size > 1) {
      return taskError('INVALID_REQUEST', 'A request containing extend_hold must contain only extend_hold entries.', 'refinements');
    }
    return serialized(ctx, () => extendHolds(args, refinements, ctx));
  }
  if (actions.size === 1 && actions.has('finalize')) {
    return serialized(ctx, () => finalizeWithHolds(refinements, ctx, inner, served));
  }
  // Revisions: drafts carry their binding policy.
  if (!served) return inner();
  const result = await runWithHoldPlan({ installmentFlights: true }, inner);
  if (hasErrors(result) || !Array.isArray(result.results)) return result;
  const { session, doc } = await sessionAndDoc(ctx);
  const drafts = result.results.filter(isRecord)
    .flatMap(entry => (Array.isArray(entry.proposals) ? entry.proposals.filter(isRecord) : []));
  if (recordDraftPolicies(doc, drafts)) {
    saveHoldDocument(session, doc, await sandboxNow(ctx));
    await flushDirtySessions();
  }
  decorateRefineResponse(doc, result);
  return result;
}

async function finalizeWithHolds(
  refinements: Json[],
  ctx: TrainingContext,
  inner: () => Promise<Json>,
  served: boolean,
): Promise<Json> {
  const sourceIds = refinements.map(entry => entry.proposal_id).filter((id): id is string => typeof id === 'string');
  const { session, doc } = await sessionAndDoc(ctx);
  const drafts = resolveFinalizeDrafts(session, sourceIds);
  if (!drafts) {
    const result = await inner();
    if (served && !hasErrors(result)) decorateRefineResponse(doc, result);
    return result;
  }
  if (!served) {
    // A caller below 3.3 never receives a committed proposal whose policy is
    // terms-only. Only drafts served to a 3.3 caller carry a policy.
    const termsOnly = drafts.find(draft => draftPolicyRecord(doc, draft.id)?.available === false);
    if (termsOnly) {
      return taskError(
        'UNSUPPORTED_FEATURE',
        `Proposal ${termsOnly.id} commits terms only, without an inventory hold, which requires AdCP 3.3 or later.`,
        'refinements',
      );
    }
    return inner();
  }
  const now = await sandboxNow(ctx);
  const plan = planFinalize(doc, drafts, now);
  if ('failures' in plan) {
    const forced = [...plan.failures].filter(([, failure]) => failure === 'forced').map(([id]) => id);
    if (forced.length > 0) {
      // The directive is consumed: the next finalize proceeds as it would have.
      doc.forced = doc.forced.filter(entry => !forced.includes(entry.proposal_id));
      saveHoldDocument(session, doc, now);
      await flushDirtySessions();
    }
    return batchFailureResponse(
      sourceIds,
      new Map([...plan.failures].map(([id, failure]) => [id, { reason_code: 'hold_unavailable', reason: FAILURE_REASONS[failure] }])),
      productsFor(drafts.map(draft => draft.proposal)).map(product => ({ ...product, ...decoratedHint(product) })),
    );
  }
  const expiresAtBySource = new Map(plan.placed
    .filter(hold => hold.expiresAt)
    .map(hold => [hold.sourceId, hold.expiresAt!]));
  const result = await runWithHoldPlan({ expiresAtBySource }, inner);
  if (hasErrors(result) || !Array.isArray(result.results)) return result;
  const { session: after, doc: current } = await sessionAndDoc(ctx);
  const bySource = new Map(plan.placed.map(hold => [hold.sourceId, hold]));
  for (const entry of result.results.filter(isRecord)) {
    const hold = typeof entry.source_proposal_id === 'string' ? bySource.get(entry.source_proposal_id) : undefined;
    const committed = isRecord(entry.proposal) ? entry.proposal : undefined;
    if (entry.outcome !== 'finalized' || !hold || !committed || typeof committed.proposal_id !== 'string') continue;
    current.holds.push({
      proposal_id: committed.proposal_id,
      draft_id: hold.sourceId,
      ...(hold.ownerAccountId && { owner_account_id: hold.ownerAccountId }),
      policy: hold.policy,
      ...(hold.placedAt && { placed_at: hold.placedAt }),
      // A terms-only commitment's acceptance window is the engine's.
      expires_at: hold.expiresAt ?? String(committed.expires_at),
      seq: hold.seq,
      slots: hold.slots,
      ...(hold.rank !== undefined && { rank: hold.rank }),
      ...(hold.holds && { holds: hold.holds }),
      state: 'live',
    });
  }
  current.next_seq = Math.max(current.next_seq, ...plan.placed.map(hold => hold.seq + 1));
  saveHoldDocument(after, current, now);
  await flushDirtySessions();
  decorateRefineResponse(current, result);
  return result;
}

function decoratedHint(product: Json): Json {
  const policy = typeof product.product_id === 'string' ? productHoldPolicy(product.product_id) : undefined;
  return policy ? { hold_policy: policy } : {};
}

// ── extend_hold ─────────────────────────────────────────────────

function extensionId(idempotencyKey: string, sourceId: string): string {
  const digest = createHash('sha256').update(idempotencyKey).update('\0').update(sourceId).digest('hex').slice(0, 24);
  return `proposal_extension_${digest}`;
}

async function extendHolds(args: Json, refinements: Json[], ctx: TrainingContext): Promise<Json> {
  const key = typeof args.idempotency_key === 'string' ? args.idempotency_key : 'unkeyed';
  const sourceIds = refinements.map(entry => entry.proposal_id).filter((id): id is string => typeof id === 'string');
  const now = await sandboxNow(ctx);
  const outcome = await withCompactProposalSessionLock(ctx, async session => {
    const doc = loadHoldDocument(session);
    const internals = new Map((session.lastGetProductsContext?.proposals ?? [])
      .map(proposal => [proposal.proposal_id, proposal as unknown as Json]));
    const unavailable = new Map<string, { reason_code: string; reason: string }>();
    const sources: Array<{ id: string; internal: Json; record: HoldRecord | undefined; ownerAccountId?: string }> = [];
    // Task-level failures first, in request order: the batch is atomic.
    for (const id of sourceIds) {
      const stored = session.proposalRefinementRecords.get(id);
      const internal = internals.get(id);
      if (!stored || !internal) {
        unavailable.set(id, { reason_code: 'source_unavailable', reason: 'The source proposal was not found.' });
        continue;
      }
      const proposal = stored.proposal as unknown as Json;
      if (stored.declined || internal.__declined === true) {
        return taskError('INVALID_STATE', `Proposal ${id} was declined; it holds nothing to extend.`, 'refinements');
      }
      if (stored.accepted || internal.__executed === true) {
        return taskError('INVALID_STATE', `Proposal ${id} was accepted, which consumed its hold.`, 'refinements');
      }
      if (proposal.proposal_status === 'draft') {
        return taskError('PROPOSAL_NOT_COMMITTED', `Proposal ${id} is a draft; finalize it to place a hold.`, 'refinements');
      }
      const record = holdRecord(doc, id);
      if (record?.state === 'superseded') {
        return taskError(
          'INVALID_STATE',
          `Proposal ${id} was already extended; extend its committed successor instead.`,
          'refinements',
        );
      }
      if (record?.state === 'accepted' || record?.state === 'released') {
        return taskError('INVALID_STATE', `Proposal ${id} no longer holds inventory.`, 'refinements');
      }
      if (record && !record.policy.available) {
        return taskError(
          'INVALID_STATE',
          `Proposal ${id} committed terms only and holds no inventory, so there is no hold to extend.`,
          'refinements',
        );
      }
      const expiresAt = record?.expires_at ?? (typeof proposal.expires_at === 'string' ? proposal.expires_at : undefined);
      if (expiresAt && Date.parse(expiresAt) <= now) {
        return taskError('PROPOSAL_EXPIRED', `Proposal ${id} expired at ${expiresAt}; finalize the draft again.`, 'refinements');
      }
      sources.push({ id, internal, record, ...(stored.ownerAccountId && { ownerAccountId: stored.ownerAccountId }) });
    }
    const extended = new Map<string, number>();
    for (const { id, record } of sources) {
      if (!record?.placed_at) {
        unavailable.set(id, {
          reason_code: 'hold_unavailable',
          reason: 'This hold was placed without a hold policy, and the seller does not extend it.',
        });
        continue;
      }
      if (record.policy.extendable !== true) {
        unavailable.set(id, { reason_code: 'hold_unavailable', reason: "The hold's policy is not extendable." });
        continue;
      }
      const current = Date.parse(record.expires_at);
      const step = record.policy.max_duration ? durationMs(record.policy.max_duration) : DEFAULT_HOLD_MS;
      const total = record.policy.max_total_duration
        ? Date.parse(record.placed_at) + durationMs(record.policy.max_total_duration)
        : Number.POSITIVE_INFINITY;
      const cap = installmentDeadlineCap(productIdsOf(session.proposalRefinementRecords.get(id)!.proposal as unknown as Json));
      const next = Math.min(current + step, total, cap ?? Number.POSITIVE_INFINITY);
      if (next <= current) {
        unavailable.set(id, {
          reason_code: 'hold_unavailable',
          reason: "No later expiry fits within the hold's total duration or the installments' booking deadline.",
        });
        continue;
      }
      extended.set(id, next);
    }
    if (unavailable.size > 0) {
      const sourceProposals = sourceIds
        .map(id => session.proposalRefinementRecords.get(id)?.proposal as unknown as Json | undefined)
        .filter(isRecord);
      return batchFailureResponse(sourceIds, unavailable, productsFor(sourceProposals).map(product => ({ ...product, ...decoratedHint(product) })));
    }
    // Persist each successor and transfer its hold in one write.
    const internalList = [...(session.lastGetProductsContext?.proposals ?? [])];
    const results: Json[] = [];
    const successors: Json[] = [];
    for (const { id, internal, record, ownerAccountId } of sources) {
      const successorId = extensionId(key, id);
      const expiresAt = new Date(extended.get(id)!).toISOString();
      const successorInternal: Json = {
        ...structuredClone(internal),
        proposal_id: successorId,
        expires_at: expiresAt,
        __parent_proposal_id: id,
        __source_proposal_id: id,
      };
      const outward = compactProposalOutward(successorInternal);
      internalList.push(successorInternal as never);
      session.proposalRefinementRecords.set(successorId, {
        proposal: outward as never,
        version: 1,
        ...(ownerAccountId && { ownerAccountId }),
      });
      const source = record!;
      source.state = 'superseded';
      source.superseded_by = successorId;
      // The hold keeps its queue position, so its rank can only improve.
      const successorRecord: HoldRecord = {
        ...structuredClone(source),
        proposal_id: successorId,
        expires_at: expiresAt,
        state: 'live',
        superseded_by: undefined,
      };
      delete successorRecord.superseded_by;
      if (source.policy.rankable === true) {
        successorRecord.rank = currentRank(doc, source, now);
        successorRecord.holds = source.holds?.map(entry => ({
          ...entry,
          hold_rank: positionOn(doc, installmentSlot(entry), source.seq, now),
        }));
      }
      doc.holds.push(successorRecord);
      const decorated = { ...outward, ...committedHoldFields(successorRecord) };
      successors.push(decorated);
      results.push({ source_proposal_id: id, outcome: 'finalized', proposal: decorated });
    }
    session.lastGetProductsContext = {
      ...(session.lastGetProductsContext ?? {}),
      proposals: internalList,
    };
    saveHoldDocument(session, doc, now);
    return {
      results,
      products: productsFor(successors).map(product => ({ ...product, ...decoratedHint(product) })),
    };
  });
  return outcome as Json;
}

// ── comply_test_controller force_hold_unavailable ────────────────

export async function forceHoldUnavailable(params: Json, ctx: TrainingContext): Promise<Json> {
  return withSeededHoldPolicies(ctx, () => registerForcedHoldUnavailable(params, ctx));
}

async function registerForcedHoldUnavailable(params: Json, ctx: TrainingContext): Promise<Json> {
  if (!holdsServed(ctx)) {
    return {
      success: false,
      error: 'UNKNOWN_SCENARIO',
      error_detail: 'force_hold_unavailable is an experimental AdCP 3.3 scenario (media_buy.hold_policy).',
    };
  }
  const proposalId = typeof params.proposal_id === 'string' && params.proposal_id.length > 0 ? params.proposal_id : undefined;
  if (!proposalId) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: 'force_hold_unavailable requires params.proposal_id' };
  }
  const sessionKey = compactProposalSessionKey(ctx);
  const session = await getSession(sessionKey);
  const stored = session.proposalRefinementRecords.get(proposalId);
  const callerAccounts = new Set([ctx.resolvedAccountId, ctx.proposalRefinementScope?.account_id, ctx.callerMutationScope?.account_id]
    .filter((value): value is string => typeof value === 'string'));
  if (!stored || (stored.ownerAccountId && callerAccounts.size > 0 && !callerAccounts.has(stored.ownerAccountId))) {
    return { success: false, error: 'NOT_FOUND', error_detail: `Proposal ${proposalId} was not found in this sandbox account` };
  }
  const proposal = stored.proposal as unknown as Json;
  const doc = loadHoldDocument(session);
  if (proposal.proposal_status !== 'draft' || stored.declined || stored.accepted) {
    return { success: false, error: 'INVALID_STATE', error_detail: `Proposal ${proposalId} is not a draft` };
  }
  if (!draftPolicy(doc, proposal).available) {
    return {
      success: false,
      error: 'INVALID_STATE',
      error_detail: `Proposal ${proposalId} commits terms only, so hold_unavailable is never valid for it`,
    };
  }
  if (!doc.forced.some(entry => entry.proposal_id === proposalId)) {
    doc.forced.push({ proposal_id: proposalId });
    saveHoldDocument(session, doc, await sandboxNow(ctx));
    await flushDirtySessions();
  }
  return {
    success: true,
    forced: { arm: 'unable', proposal_id: proposalId },
    message: `The next finalize that includes ${proposalId} returns hold_unavailable`,
  };
}

/** Whether a stored record still stands on its slots (exported for tests). */
export { occupiesSlots };
