/**
 * Seller-optimized shared-budget contract for the training agent.
 *
 * `media_buy.features.seller_optimized_budget` covers the core shared-budget
 * contract; package budget caps, minimum-spend targets, and package pacing are
 * separate sub-capabilities. The declaration helpers below are the single
 * source of truth for both the advertised capability and the rejection paths,
 * so the agent never declares a control it does not enforce.
 *
 * Contract (docs/media-buy/task-reference/create_media_buy.mdx, "Seller-optimized
 * allocation"):
 * 1. A request that needs an undeclared capability is rejected with
 *    UNSUPPORTED_FEATURE before any over-subscription validation or mutation.
 * 2. Over-subscription checks (INVALID_REQUEST) apply only to declared controls.
 * 3. A selected pricing option outside the media-buy currency is rejected with
 *    TERMS_REJECTED (enforced where pricing options are resolved).
 */

import { createHash } from 'node:crypto';
import { supportsBiddingPolicyCapability } from './types.js';

export interface SellerOptimizedDeclaration {
  seller_optimized_budget: boolean;
  seller_optimized_package_budgets: boolean;
  seller_optimized_min_spend_targets: boolean;
  seller_optimized_package_pacing: boolean;
}

export type SellerOptimizedFeatureKey = keyof SellerOptimizedDeclaration;

const UNDECLARED: SellerOptimizedDeclaration = Object.freeze({
  seller_optimized_budget: false,
  seller_optimized_package_budgets: false,
  seller_optimized_min_spend_targets: false,
  seller_optimized_package_pacing: false,
});

/**
 * What the training agent enforces on a served release line. Seller-optimized
 * budgets arrived alongside the structured bidding_policy capability in
 * 3.2-beta.6; frozen 3.0/3.1 projections never declare them.
 */
export function sellerOptimizedDeclarationForVersion(servedVersion: string | undefined): SellerOptimizedDeclaration {
  if (!supportsBiddingPolicyCapability(servedVersion)) return UNDECLARED;
  return {
    seller_optimized_budget: true,
    seller_optimized_package_budgets: true,
    seller_optimized_min_spend_targets: true,
    seller_optimized_package_pacing: true,
  };
}

/** The `media_buy.features` entries to advertise: only declared, enforced flags. */
export function sellerOptimizedFeatureFlags(declaration: SellerOptimizedDeclaration): Partial<Record<SellerOptimizedFeatureKey, true>> {
  return Object.fromEntries(
    Object.entries(declaration).filter(([, declared]) => declared).map(([key]) => [key, true]),
  );
}

export interface SellerOptimizedPackageControls {
  /** Wire path of the package, for example `packages[0]` or `packages[pkg-1]`. */
  ref: string;
  /** Hard package cap. Absent or null when the package is uncapped. */
  budget?: number | null;
  min_spend_target?: number | null;
  pacing?: string | null;
}

export interface SellerOptimizedState {
  allocationMode: string | undefined;
  totalBudget: number | undefined;
  /** Effective media-buy pacing; omitted pacing is `even`. */
  pacing: string | undefined;
  packages: readonly SellerOptimizedPackageControls[];
}

export interface SellerOptimizedError {
  code: 'UNSUPPORTED_FEATURE' | 'INVALID_REQUEST';
  message: string;
  field: string;
  recovery: 'correctable';
}

function unsupported(field: string, feature: SellerOptimizedFeatureKey, message: string): SellerOptimizedError {
  return {
    code: 'UNSUPPORTED_FEATURE',
    message: `${message} This seller does not declare media_buy.features.${feature}.`,
    field,
    recovery: 'correctable',
  };
}

function invalid(field: string, message: string): SellerOptimizedError {
  return { code: 'INVALID_REQUEST', message, field, recovery: 'correctable' };
}

const present = (value: unknown): value is number | string => value !== undefined && value !== null;

/**
 * Reject a seller-optimized request that needs a capability the seller does
 * not declare. Runs before over-subscription validation and any mutation, and
 * never drops or coerces the offending control.
 */
export function sellerOptimizedUnsupportedError(
  state: SellerOptimizedState,
  declaration: SellerOptimizedDeclaration,
): SellerOptimizedError | undefined {
  if (state.allocationMode !== 'seller_optimized') return undefined;
  if (!declaration.seller_optimized_budget) {
    return unsupported(
      'budget_allocation.mode',
      'seller_optimized_budget',
      'budget_allocation.mode "seller_optimized" is not supported.',
    );
  }
  const effectivePacing = state.pacing ?? 'even';
  for (const pkg of state.packages) {
    if (present(pkg.budget) && !declaration.seller_optimized_package_budgets) {
      return unsupported(
        `${pkg.ref}.budget`,
        'seller_optimized_package_budgets',
        'A package budget cap is not supported in a seller-optimized buy.',
      );
    }
    if (present(pkg.min_spend_target) && !declaration.seller_optimized_min_spend_targets) {
      return unsupported(
        `${pkg.ref}.min_spend_target`,
        'seller_optimized_min_spend_targets',
        'A package min_spend_target is not supported in a seller-optimized buy.',
      );
    }
    // Package pacing equal to the effective media-buy pacing adds no
    // subordinate constraint and needs no capability.
    if (present(pkg.pacing) && pkg.pacing !== effectivePacing && !declaration.seller_optimized_package_pacing) {
      return unsupported(
        `${pkg.ref}.pacing`,
        'seller_optimized_package_pacing',
        'Package pacing that differs from the media-buy pacing is not supported in a seller-optimized buy.',
      );
    }
  }
  return undefined;
}

/**
 * Over-subscription validation, applied only to declared controls: a minimum
 * above its own package cap (needs both package budgets and minimum-spend
 * targets), package minimums summing above the shared total, and package caps
 * that cannot collectively spend it.
 */
export function sellerOptimizedOversubscriptionError(
  state: SellerOptimizedState,
  declaration: SellerOptimizedDeclaration,
): SellerOptimizedError | undefined {
  if (state.allocationMode !== 'seller_optimized') return undefined;
  // Package caps that cannot collectively spend the shared total make the
  // request infeasible; one uncapped package keeps the full total reachable.
  if (
    declaration.seller_optimized_package_budgets
    && state.totalBudget !== undefined
    && state.packages.length > 0
    && state.packages.every(pkg => typeof pkg.budget === 'number')
  ) {
    const capSum = state.packages.reduce((sum, pkg) => sum + (pkg.budget as number), 0);
    if (capSum < state.totalBudget) {
      return invalid(
        'total_budget',
        `Package budget caps sum to ${capSum}, below total_budget ${state.totalBudget}; the shared total cannot be spent.`,
      );
    }
  }
  if (!declaration.seller_optimized_min_spend_targets) return undefined;
  let minimumSum = 0;
  for (const pkg of state.packages) {
    if (typeof pkg.min_spend_target !== 'number') continue;
    minimumSum += pkg.min_spend_target;
    if (
      declaration.seller_optimized_package_budgets
      && typeof pkg.budget === 'number'
      && pkg.min_spend_target > pkg.budget
    ) {
      return invalid(
        `${pkg.ref}.min_spend_target`,
        `${pkg.ref}: min_spend_target ${pkg.min_spend_target} exceeds the package budget ${pkg.budget}.`,
      );
    }
  }
  if (state.totalBudget !== undefined && minimumSum > state.totalBudget) {
    return invalid(
      'total_budget',
      `Package min_spend_target values sum to ${minimumSum}, above total_budget ${state.totalBudget}.`,
    );
  }
  return undefined;
}

/** Both checks in contract order: undeclared controls first, then over-subscription. */
export function sellerOptimizedStateError(
  state: SellerOptimizedState,
  declaration: SellerOptimizedDeclaration,
): SellerOptimizedError | undefined {
  return sellerOptimizedUnsupportedError(state, declaration)
    ?? sellerOptimizedOversubscriptionError(state, declaration);
}

const SELLER_OPTIMIZED_PROPOSAL_ID_PREFIX = 'seller_optimized_';

/** Whether a proposal ID names a draft synthesized from a shared-budget brief. */
export function isSellerOptimizedProposalId(proposalId: string): boolean {
  return proposalId.startsWith(SELLER_OPTIMIZED_PROPOSAL_ID_PREFIX);
}

const BRIEF_METRICS = ['completed_views', 'engagements', 'clicks', 'views', 'reach'] as const;
const DEFAULT_PROPOSAL_BUDGET = 100_000;

interface ProposalProductView {
  product_id: string;
  name?: string;
  pricing_options: ReadonlyArray<{ pricing_option_id: string; currency?: string }>;
}

export interface SellerOptimizedProposalDraft {
  proposal_id: string;
  name: string;
  description: string;
  brief_alignment: string;
  total_budget_guidance: { min: number; recommended: number; currency: string };
  budget_allocation: {
    mode: 'seller_optimized';
    optimization_goals: Array<{ kind: 'metric'; metric: string; priority: number }>;
  };
  pacing: string;
  allocations: Array<{
    product_id: string;
    pricing_option_id: string;
    rationale: string;
    pacing?: string;
  }>;
}

function budgetFromBrief(brief: string): number {
  const match = brief.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?\b/i);
  if (!match) return DEFAULT_PROPOSAL_BUDGET;
  const amount = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_PROPOSAL_BUDGET;
  const scale = match[2]?.toLowerCase();
  return scale === 'k' ? amount * 1_000 : scale === 'm' ? amount * 1_000_000 : amount;
}

/**
 * Deterministic seller-optimized proposal for a brief that asks for a shared
 * budget ("propose a shared budget ...") over the buyer-seeded fixture
 * products. Emitted only when the seller declares the core capability; the
 * subordinate allocation pacing named in the brief ("front-load retargeting")
 * is emitted only with seller_optimized_package_pacing, and no
 * min_spend_target_percentage or max_spend_percentage is ever emitted because
 * the brief carries no per-product targets or caps.
 */
export function sellerOptimizedProposalForBrief(
  brief: string | undefined,
  products: readonly ProposalProductView[],
  declaration: SellerOptimizedDeclaration,
): SellerOptimizedProposalDraft | undefined {
  if (!declaration.seller_optimized_budget || !brief) return undefined;
  const text = brief.toLowerCase();
  if (!/\bpropos(?:e|al)\b/.test(text) || !/\bshared\b/.test(text)) return undefined;

  const currency = products[0]?.pricing_options[0]?.currency;
  if (!currency) return undefined;
  const selected = products.flatMap(product => {
    const option = product.pricing_options.find(candidate => candidate.currency === currency);
    return option ? [{ product, option }] : [];
  });
  if (selected.length < 2) return undefined;

  const metric = BRIEF_METRICS.find(candidate => (
    new RegExp(`\\b${candidate.replace('_', '[ _]')}\\b`).test(text)
  )) ?? 'clicks';
  const aggregatePacing = text.match(/\bpace the buy (evenly|asap|front[- ]?loaded)\b/)?.[1];
  const pacing = aggregatePacing === 'asap' ? 'asap' : aggregatePacing?.startsWith('front') ? 'front_loaded' : 'even';
  const frontLoadTerm = [...text.matchAll(/\bfront[- ]?load(?:ed)?\s+([a-z0-9_-]+)/g)]
    .map(match => match[1])
    .find(term => !['and', 'the', 'a', 'an', 'then'].includes(term));
  const budget = budgetFromBrief(brief);

  const content = {
    name: 'Seller-optimized shared budget',
    description: 'One shared budget the seller allocates continuously across the selected products.',
    brief_alignment: 'Delegates cross-product allocation to the seller against the goal named in the brief.',
    total_budget_guidance: { min: budget, recommended: budget, currency },
    budget_allocation: {
      mode: 'seller_optimized' as const,
      optimization_goals: [{ kind: 'metric' as const, metric, priority: 1 }],
    },
    pacing,
    allocations: selected.map(({ product, option }) => ({
      product_id: product.product_id,
      pricing_option_id: option.pricing_option_id,
      rationale: 'Eligible for seller-optimized allocation of the shared budget.',
      ...(declaration.seller_optimized_package_pacing
        && frontLoadTerm
        && `${product.product_id} ${product.name ?? ''}`.toLowerCase().includes(frontLoadTerm)
        && { pacing: 'front_loaded' }),
    })),
  };
  // The ID is a digest of the terms, so identical briefs resolve to one
  // proposal and a brief with different terms never aliases an earlier draft.
  const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
  return { proposal_id: `${SELLER_OPTIMIZED_PROPOSAL_ID_PREFIX}${digest}`, ...content };
}
