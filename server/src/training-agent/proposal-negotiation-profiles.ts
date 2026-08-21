import { createHash } from "node:crypto";
import type {
  CanonicalProposal,
  ProposalCommercialTerms,
  ProposalEvaluationContext,
  ProposalPurchase,
  ProposalRefinementCapabilities,
  ProposalRefinementResult,
} from "@adcp/sdk";
import {
  classifyProposalRefinementFailure,
  createProposalSuccessor,
  defineProposalRefinementCapabilities,
} from "@adcp/sdk/server";
import type { ProposalNegotiationProfile } from "./types.js";

const TYPED_DIMENSIONS = [
  "total_budget",
  "cpm",
  "impressions",
  "flight",
  "product_changes",
  "criteria",
  "alternatives",
] as const;

export const ASK_ONLY_PROPOSAL_CAPABILITIES =
  defineProposalRefinementCapabilities({
    supported_dimensions: [],
  });

export const TYPED_PROPOSAL_CAPABILITIES = defineProposalRefinementCapabilities(
  {
    supported_dimensions: TYPED_DIMENSIONS,
    max_alternatives: 3,
  }
);

export function proposalCapabilitiesForProfile(
  profile: ProposalNegotiationProfile | undefined
): ProposalRefinementCapabilities {
  return !profile || profile === "ask-only"
    ? ASK_ONLY_PROPOSAL_CAPABILITIES
    : TYPED_PROPOSAL_CAPABILITIES;
}

export interface TrainingProposalPolicyContext {
  profile: Exclude<ProposalNegotiationProfile, "ask-only">;
  now: Date;
  activeHoldCount: number;
  purchaseForProduct(
    productId: string,
    source: CanonicalProposal
  ): ProposalPurchase | undefined;
}

type Evaluation = ProposalEvaluationContext<
  CanonicalProposal,
  TrainingProposalPolicyContext
>;
type TrainingProposalPurchase = ProposalPurchase & {
  budget?: number;
  ext?: Record<string, unknown>;
};
type TrainingCommercialTerms =
  ProposalCommercialTerms<TrainingProposalPurchase> & {
    cancellation_terms?: { effective_at: string; reason?: string };
  };

function successorId(evaluation: Evaluation, alternative: number): string {
  const digest = createHash("sha256")
    .update(evaluation.request.idempotency_key)
    .update("\0")
    .update(evaluation.refinement.proposal_id)
    .update("\0")
    .update(evaluation.refinement.action)
    .update("\0")
    .update(String(alternative))
    .digest("hex")
    .slice(0, 24);
  return `proposal_training_${digest}`;
}

function futureIso(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function unable(
  sourceProposalId: string,
  failure: Parameters<typeof classifyProposalRefinementFailure>[0],
  reason: string,
  extra: Partial<Extract<ProposalRefinementResult, { outcome: "unable" }>> = {}
): Extract<ProposalRefinementResult, { outcome: "unable" }> {
  return {
    source_proposal_id: sourceProposalId,
    outcome: "unable",
    reason_code: classifyProposalRefinementFailure(failure),
    reason,
    ...extra,
  };
}

function trainingScenario(
  ask: string | undefined
): "commercially-declined" | "unsupported-dimension" | undefined {
  if (!ask) return undefined;
  if (/\[commercially-declined\]/i.test(ask)) return "commercially-declined";
  if (/\[unsupported-dimension\]/i.test(ask)) return "unsupported-dimension";
  return undefined;
}

function applyBudgetConstraint(
  terms: ProposalCommercialTerms,
  constraint: { currency: string; min?: number; max?: number },
  profile: TrainingProposalPolicyContext["profile"]
): boolean {
  const floor = profile === "constrained-seller" ? 40_000 : 10_000;
  const ceiling = profile === "constrained-seller" ? 150_000 : 250_000;
  if (constraint.currency !== "USD") return false;
  const lower = Math.max(floor, constraint.min ?? floor);
  const upper = Math.min(ceiling, constraint.max ?? ceiling);
  if (lower > upper) return false;
  const amount = Math.min(upper, Math.max(lower, 50_000));
  terms.total_budget = { amount, currency: "USD" };
  const share =
    terms.purchases.length > 0 ? amount / terms.purchases.length : amount;
  for (const purchase of terms.purchases)
    (purchase as TrainingProposalPurchase).budget = share;
  return true;
}

function applyCpmConstraint(
  terms: ProposalCommercialTerms,
  constraint: { max: number; currency: string },
  profile: TrainingProposalPolicyContext["profile"]
): boolean {
  const floor = profile === "constrained-seller" ? 8 : 2;
  if (constraint.currency !== "USD" || constraint.max < floor) return false;
  for (const purchase of terms.purchases) {
    purchase.pricing = {
      ...purchase.pricing,
      pricing_model: "cpm",
      currency: "USD",
      fixed_price: floor,
    };
    delete purchase.pricing.floor_price;
  }
  return true;
}

function applyImpressionsConstraint(
  terms: ProposalCommercialTerms,
  constraint: { min: number },
  profile: TrainingProposalPolicyContext["profile"]
): boolean {
  const ceiling = profile === "constrained-seller" ? 2_000_000 : 10_000_000;
  if (constraint.min > ceiling || terms.purchases.length === 0) return false;
  const perPurchase = Math.ceil(constraint.min / terms.purchases.length);
  for (const purchase of terms.purchases) purchase.impressions = perPurchase;
  return true;
}

function applyFlightConstraint(
  terms: ProposalCommercialTerms,
  constraint: { start_no_later_than?: string; end_no_earlier_than?: string }
): boolean {
  if (constraint.start_no_later_than !== undefined) {
    const deadline = Date.parse(constraint.start_no_later_than);
    if (!Number.isFinite(deadline)) return false;
    const current =
      terms.start_time === "asap"
        ? Number.POSITIVE_INFINITY
        : Date.parse(terms.start_time);
    if (!Number.isFinite(current) || current > deadline) {
      terms.start_time = constraint.start_no_later_than;
      for (const purchase of terms.purchases)
        purchase.start_time = constraint.start_no_later_than;
    }
  }
  if (constraint.end_no_earlier_than !== undefined) {
    const boundary = Date.parse(constraint.end_no_earlier_than);
    if (!Number.isFinite(boundary)) return false;
    const current = Date.parse(terms.end_time);
    if (!Number.isFinite(current) || current < boundary) {
      terms.end_time = constraint.end_no_earlier_than;
      for (const purchase of terms.purchases)
        purchase.end_time = constraint.end_no_earlier_than;
    }
  }
  return true;
}

function applyProductChanges(
  terms: ProposalCommercialTerms,
  evaluation: Evaluation
): Record<string, "include" | "omit"> {
  const changes =
    evaluation.refinement.action === "revise"
      ? evaluation.refinement.product_changes ?? {}
      : {};
  const unsatisfied: Record<string, "include" | "omit"> = {};
  const purchases = new Map(
    terms.purchases.map((purchase) => [purchase.product_id, purchase])
  );
  for (const [productId, action] of Object.entries(changes)) {
    if (action === "omit") purchases.delete(productId);
  }
  for (const [productId, action] of Object.entries(changes)) {
    if (action !== "include" || purchases.has(productId)) continue;
    const purchase = evaluation.context.purchaseForProduct(
      productId,
      evaluation.source!
    );
    if (
      !purchase ||
      (evaluation.context.profile === "constrained-seller" &&
        productId.toLowerCase().includes("premium"))
    ) {
      unsatisfied[productId] = action;
      continue;
    }
    purchases.set(productId, structuredClone(purchase));
  }
  if (
    evaluation.context.profile === "constrained-seller" &&
    purchases.size > 3
  ) {
    for (const [productId, action] of Object.entries(changes)) {
      if (
        action === "include" &&
        !terms.purchases.some((purchase) => purchase.product_id === productId)
      ) {
        unsatisfied[productId] = action;
        purchases.delete(productId);
      }
    }
  }
  if (purchases.size === 0) {
    const omitted = Object.entries(changes).find(
      ([, action]) => action === "omit"
    );
    if (omitted) unsatisfied[omitted[0]] = "omit";
  } else {
    terms.purchases = Array.from(purchases.values());
  }
  return unsatisfied;
}

function targetingResolution(
  evaluation: Evaluation
): Record<string, unknown> | undefined {
  if (
    evaluation.refinement.action !== "revise" ||
    !evaluation.refinement.criteria
  )
    return undefined;
  const criteria = evaluation.refinement.criteria;
  return {
    applied: true,
    ...(criteria.product_ids && { product_ids: [...criteria.product_ids] }),
    ...(criteria.targeting_overlay && {
      targeting_overlay: structuredClone(criteria.targeting_overlay),
    }),
    ...(criteria.required_overlay_support && {
      required_overlay_support: structuredClone(
        criteria.required_overlay_support
      ),
    }),
  };
}

function finalize(evaluation: Evaluation): ProposalRefinementResult {
  const sourceId = evaluation.refinement.proposal_id;
  const source = evaluation.source;
  if (!source)
    return unable(
      sourceId,
      { source_unavailable: true },
      "The source proposal does not exist."
    );
  if (evaluation.context.profile === "finalization-failure") {
    if (evaluation.index === 0) {
      return unable(
        sourceId,
        { hold_unavailable: true },
        "The deterministic hold policy rejected this inventory hold."
      );
    }
    return unable(
      sourceId,
      { batch_aborted: true },
      "The batch was aborted because a sibling hold could not be created."
    );
  }
  const finalizeCount = evaluation.request.refinements.filter(
    (entry) => entry.action === "finalize"
  ).length;
  if (evaluation.context.activeHoldCount + finalizeCount > 3) {
    if (evaluation.index === 0) {
      return unable(
        sourceId,
        { hold_unavailable: true },
        "The buyer has reached the deterministic three-hold concurrency cap."
      );
    }
    return unable(
      sourceId,
      { batch_aborted: true },
      "The batch was aborted because a sibling exceeded the hold-policy cap."
    );
  }
  return {
    source_proposal_id: sourceId,
    outcome: "finalized",
    proposal: createProposalSuccessor(source, {
      ...source,
      proposal_id: successorId(evaluation, 0),
      proposal_status: "committed",
      expires_at: futureIso(evaluation.context.now, 15 * 60 * 1000),
      commercial_terms: structuredClone(source.commercial_terms),
    }),
  };
}

export function evaluateTrainingProposal(
  evaluation: Evaluation
): ProposalRefinementResult {
  if (evaluation.refinement.action === "finalize") return finalize(evaluation);
  const sourceId = evaluation.refinement.proposal_id;
  const source = evaluation.source;
  if (!source)
    return unable(
      sourceId,
      { source_unavailable: true },
      "The source proposal does not exist."
    );

  const scenario = trainingScenario(evaluation.refinement.ask);
  if (scenario === "commercially-declined") {
    return unable(
      sourceId,
      { commercially_declined: true },
      "The seller declined the requested commercial change."
    );
  }
  if (scenario === "unsupported-dimension") {
    return unable(
      sourceId,
      { unsupported_dimension: true },
      "The selected fixture does not implement that criteria subtype."
    );
  }

  const terms = structuredClone(source.commercial_terms);
  const unsatisfiedConstraints: string[] = [];
  // Resolve membership first so every typed boundary is evaluated against
  // the exact purchase set that will be returned.
  const unsatisfiedProductChanges = applyProductChanges(terms, evaluation);
  const constraints = evaluation.refinement.constraints;
  if (
    constraints?.total_budget &&
    !applyBudgetConstraint(
      terms,
      constraints.total_budget,
      evaluation.context.profile
    )
  ) {
    unsatisfiedConstraints.push("total_budget");
  }
  if (
    constraints?.cpm &&
    !applyCpmConstraint(terms, constraints.cpm, evaluation.context.profile)
  ) {
    unsatisfiedConstraints.push("cpm");
  }
  if (
    constraints?.impressions &&
    !applyImpressionsConstraint(
      terms,
      constraints.impressions,
      evaluation.context.profile
    )
  ) {
    unsatisfiedConstraints.push("impressions");
  }
  if (
    constraints?.flight &&
    !applyFlightConstraint(terms, constraints.flight)
  ) {
    unsatisfiedConstraints.push("flight");
  }
  if (
    unsatisfiedConstraints.length > 0 ||
    Object.keys(unsatisfiedProductChanges).length > 0
  ) {
    return unable(
      sourceId,
      {
        unsatisfied_constraints: unsatisfiedConstraints,
        unsatisfied_product_changes: unsatisfiedProductChanges,
      },
      "One or more typed commercial constraints cannot be satisfied by this profile.",
      {
        ...(unsatisfiedConstraints.length > 0 && {
          unsatisfied_constraints: unsatisfiedConstraints,
        }),
        ...(Object.keys(unsatisfiedProductChanges).length > 0 && {
          unsatisfied_product_changes: unsatisfiedProductChanges,
        }),
        suggestions: [
          "Relax the listed constraint or choose another deterministic seller profile.",
        ],
      }
    );
  }

  const requestedCount = evaluation.refinement.alternatives?.count ?? 1;
  const availableCount =
    evaluation.context.profile === "constrained-seller"
      ? Math.min(requestedCount, 2)
      : requestedCount;
  const kind =
    evaluation.refinement.change_kind === "cancellation"
      ? "media_buy_cancellation"
      : source.proposal_status === "accepted"
      ? "media_buy_update"
      : source.proposal_kind;
  const proposals = Array.from({ length: availableCount }, (_, alternative) => {
    const alternativeTerms = structuredClone(terms);
    const firstPurchase = alternativeTerms.purchases[0] as
      | TrainingProposalPurchase
      | undefined;
    if (firstPurchase) {
      firstPurchase.ext = {
        ...(firstPurchase.ext ?? {}),
        training_alternative: alternative + 1,
      };
    }
    if (kind === "media_buy_cancellation") {
      (alternativeTerms as TrainingCommercialTerms).cancellation_terms = {
        effective_at: evaluation.context.now.toISOString(),
        ...(evaluation.refinement.action === "revise" &&
          evaluation.refinement.ask && {
            reason: evaluation.refinement.ask.slice(0, 500),
          }),
      };
    }
    return createProposalSuccessor(source, {
      ...source,
      proposal_id: successorId(evaluation, alternative),
      proposal_kind: kind,
      proposal_status: "draft",
      expires_at: futureIso(evaluation.context.now, 24 * 60 * 60 * 1000),
      commercial_terms: alternativeTerms,
      ...(source.proposal_status === "accepted" && {
        media_buy_id: source.media_buy_id,
        base_media_buy_revision: source.base_media_buy_revision,
      }),
      accepted_at: undefined,
      insertion_order: undefined,
    });
  });

  if (requestedCount > availableCount) {
    return {
      source_proposal_id: sourceId,
      outcome: "partial",
      proposals,
      reason_code: classifyProposalRefinementFailure({
        alternatives_unavailable: true,
      }),
      reason: `The constrained profile produced ${availableCount} of ${requestedCount} requested alternatives.`,
      suggestions: [`Retry with alternatives.count set to ${availableCount}.`],
      ...(targetingResolution(evaluation) && {
        targeting_resolution: targetingResolution(evaluation),
      }),
    };
  }
  if (
    evaluation.refinement.ask &&
    !constraints &&
    !evaluation.refinement.product_changes &&
    !evaluation.refinement.criteria &&
    !evaluation.refinement.alternatives &&
    !evaluation.refinement.change_kind
  ) {
    return {
      source_proposal_id: sourceId,
      outcome: "partial",
      proposals,
      reason_code: classifyProposalRefinementFailure({}),
      reason:
        "The deterministic seller could not fully interpret the free-text ask.",
      suggestions: ["Express the request with typed constraints."],
    };
  }
  return {
    source_proposal_id: sourceId,
    outcome: "revised",
    proposals,
  };
}
