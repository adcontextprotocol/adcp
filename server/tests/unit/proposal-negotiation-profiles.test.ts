import { beforeEach, describe, expect, it } from "vitest";
import type {
  CanonicalProposal,
  ProposalEvaluationContext,
  ProposalPurchase,
  ProposalRefinement,
  RefineProposalsRequest,
} from "@adcp/sdk";
import {
  proposalTermsDigest,
  validateRefineProposalsRequest,
  verifyRefineProposalsResponse,
} from "@adcp/sdk";
import {
  ASK_ONLY_PROPOSAL_CAPABILITIES,
  TYPED_PROPOSAL_CAPABILITIES,
  evaluateTrainingProposal,
  proposalCapabilitiesForProfile,
  type TrainingProposalPolicyContext,
} from "../../src/training-agent/proposal-negotiation-profiles.js";
import {
  PROPOSAL_NEGOTIATION_PROFILE_ROUTES,
  proposalNegotiationProfilesEnabled,
} from "../../src/training-agent/tenants/router.js";
import { buildCatalog } from "../../src/training-agent/product-factory.js";
import {
  executeTrainingAgentTool,
  invalidateCache,
} from "../../src/training-agent/task-handlers.js";
import { clearSessions } from "../../src/training-agent/state.js";
import { clearIdempotencyCache } from "../../src/training-agent/idempotency.js";
import type { TrainingContext } from "../../src/training-agent/types.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function purchase(productId: string): ProposalPurchase {
  return {
    product_id: productId,
    pricing_option_id: `${productId}_cpm`,
    pricing: {
      pricing_option_id: `${productId}_cpm`,
      pricing_model: "cpm",
      currency: "USD",
      fixed_price: 12,
    },
    start_time: "2030-01-02T00:00:00.000Z",
    end_time: "2030-02-01T00:00:00.000Z",
  };
}

function sourceProposal(
  id = "proposal_source_0001",
  status: CanonicalProposal["proposal_status"] = "draft"
): CanonicalProposal {
  const commercialTerms = {
    brand: { domain: "buyer.example" },
    purchases: [purchase("product_alpha"), purchase("product_beta")],
    start_time: "2030-01-02T00:00:00.000Z",
    end_time: "2030-02-01T00:00:00.000Z",
    total_budget: { amount: 75_000, currency: "USD" },
  };
  return {
    proposal_id: id,
    proposal_kind: "new_media_buy",
    proposal_status: status,
    ...(status === "accepted" && {
      accepted_at: "2030-01-01T00:00:00.000Z",
      media_buy_id: "media_buy_0001",
      base_media_buy_revision: 1,
    }),
    expires_at: "2030-01-02T00:00:00.000Z",
    name: "Deterministic proposal",
    commercial_terms: commercialTerms,
    terms_digest: proposalTermsDigest(commercialTerms),
  };
}

function requestFor(
  refinements: ProposalRefinement[],
  idempotencyKey = "idem-training-00000001"
): RefineProposalsRequest {
  return {
    idempotency_key: idempotencyKey,
    refinements,
    adcp_version: "3.2",
    adcp_major_version: 3,
  };
}

function evaluate(
  refinement: ProposalRefinement,
  options: {
    profile?: TrainingProposalPolicyContext["profile"];
    source?: CanonicalProposal | null;
    refinements?: ProposalRefinement[];
    index?: number;
    activeHoldCount?: number;
  } = {}
) {
  const profile = options.profile ?? "typed-negotiation";
  const refinements = options.refinements ?? [refinement];
  const context: TrainingProposalPolicyContext = {
    profile,
    now: NOW,
    activeHoldCount: options.activeHoldCount ?? 0,
    purchaseForProduct: (productId) => purchase(productId),
  };
  const evaluation: ProposalEvaluationContext<
    CanonicalProposal,
    TrainingProposalPolicyContext
  > = {
    refinement,
    source:
      options.source === undefined
        ? sourceProposal(refinement.proposal_id)
        : options.source,
    index: options.index ?? 0,
    request: requestFor(refinements),
    context,
  };
  return evaluateTrainingProposal(evaluation);
}

describe("deterministic proposal negotiation profiles", () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
    clearIdempotencyCache();
  });
  it("keeps ask-only discovery distinct from the complete typed profile", () => {
    expect(proposalCapabilitiesForProfile("ask-only")).toEqual(
      ASK_ONLY_PROPOSAL_CAPABILITIES
    );
    expect(proposalCapabilitiesForProfile("typed-negotiation")).toEqual(
      TYPED_PROPOSAL_CAPABILITIES
    );
    expect(TYPED_PROPOSAL_CAPABILITIES).toEqual({
      supported_dimensions: [
        "total_budget",
        "cpm",
        "impressions",
        "flight",
        "product_changes",
        "criteria",
        "alternatives",
      ],
      max_alternatives: 3,
    });
  });

  it("runs the required constrained three-to-two alternative scenario", () => {
    const refinement: ProposalRefinement = {
      proposal_id: "proposal_source_0001",
      action: "revise",
      constraints: { total_budget: { currency: "USD", max: 50_000 } },
      product_changes: { product_gamma: "include", product_beta: "omit" },
      criteria: {
        targeting_overlay: { geo_countries: ["US", "CA"] },
      },
      alternatives: { count: 3 },
    };
    const result = evaluate(refinement, { profile: "constrained-seller" });
    expect(result.outcome).toBe("partial");
    if (result.outcome !== "partial") throw new Error("expected partial");
    expect(result.reason_code).toBe("alternatives_unavailable");
    expect(result.proposals).toHaveLength(2);
    expect(
      new Set(result.proposals.map((proposal) => proposal.terms_digest)).size
    ).toBe(2);
    for (const proposal of result.proposals) {
      expect(proposal.parent_proposal_id).toBe(refinement.proposal_id);
      expect(proposal.commercial_terms.total_budget).toEqual({
        amount: 50_000,
        currency: "USD",
      });
      expect(
        proposal.commercial_terms.purchases.map((entry) => entry.product_id)
      ).toContain("product_gamma");
      expect(
        proposal.commercial_terms.purchases.map((entry) => entry.product_id)
      ).not.toContain("product_beta");
    }
    expect(
      verifyRefineProposalsResponse(
        requestFor([refinement]),
        { status: "completed", results: [result], products: [] },
        { now: NOW }
      )
    ).toEqual({ ok: true, issues: [] });
  });

  it("lets SDK response verification reject duplicate alternative terms and digests", () => {
    const refinement: ProposalRefinement = {
      proposal_id: "proposal_duplicate_terms",
      action: "revise",
      alternatives: { count: 3 },
    };
    const result = evaluate(refinement, { profile: "constrained-seller" });
    if (result.outcome !== "partial") throw new Error("expected partial");
    const invalid = structuredClone(result);
    invalid.proposals[1] = {
      ...invalid.proposals[1]!,
      commercial_terms: structuredClone(invalid.proposals[0]!.commercial_terms),
      terms_digest: invalid.proposals[0]!.terms_digest,
    };
    const verification = verifyRefineProposalsResponse(
      requestFor([refinement]),
      { status: "completed", results: [invalid], products: [] },
      { now: NOW }
    );
    expect(verification.ok).toBe(false);
    expect(verification.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["duplicate_terms", "duplicate_digest"])
    );
  });

  it("applies cpm, impressions, flight, amendment, and cancellation semantics", () => {
    const refinement: ProposalRefinement = {
      proposal_id: "proposal_accepted_0001",
      action: "revise",
      change_kind: "amendment",
      constraints: {
        cpm: { currency: "USD", max: 9 },
        impressions: { min: 1_000_000 },
        flight: {
          start_no_later_than: "2030-01-01T12:00:00.000Z",
          end_no_earlier_than: "2030-03-01T00:00:00.000Z",
        },
      },
    };
    const result = evaluate(refinement, {
      source: sourceProposal(refinement.proposal_id, "accepted"),
    });
    expect(result.outcome).toBe("revised");
    if (result.outcome !== "revised") throw new Error("expected revised");
    const proposal = result.proposals[0]!;
    expect(proposal.proposal_kind).toBe("media_buy_update");
    expect(proposal.proposal_status).toBe("draft");
    expect(proposal.commercial_terms.start_time).toBe(
      "2030-01-01T12:00:00.000Z"
    );
    expect(proposal.commercial_terms.end_time).toBe("2030-03-01T00:00:00.000Z");
    expect(
      proposal.commercial_terms.purchases.every(
        (entry) => entry.pricing.fixed_price === 2
      )
    ).toBe(true);
    expect(
      proposal.commercial_terms.purchases.reduce(
        (sum, entry) => sum + (entry.impressions ?? 0),
        0
      )
    ).toBeGreaterThanOrEqual(1_000_000);

    const cancellation = evaluate(
      {
        proposal_id: refinement.proposal_id,
        action: "revise",
        change_kind: "cancellation",
        ask: "Cancel at the next deterministic boundary.",
      },
      { source: sourceProposal(refinement.proposal_id, "accepted") }
    );
    expect(cancellation.outcome).toBe("revised");
    if (cancellation.outcome === "revised") {
      expect(cancellation.proposals[0]?.proposal_kind).toBe(
        "media_buy_cancellation"
      );
      expect(cancellation.proposals[0]?.commercial_terms).toHaveProperty(
        "cancellation_terms"
      );
    }
  });

  it("creates a committed immutable successor on finalize", () => {
    const source = sourceProposal();
    const refinement: ProposalRefinement = {
      proposal_id: source.proposal_id,
      action: "finalize",
    };
    const result = evaluate(refinement, { source });
    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("expected finalized");
    expect(result.proposal.parent_proposal_id).toBe(source.proposal_id);
    expect(result.proposal.proposal_status).toBe("committed");
    expect(result.proposal.commercial_terms).toEqual(source.commercial_terms);
    expect(result.proposal.terms_digest).toBe(source.terms_digest);
    expect(source.proposal_status).toBe("draft");
  });

  it("makes every reason code reachable with deterministic inputs", () => {
    const sourceId = "proposal_reason_codes";
    const holdBatch: ProposalRefinement[] = [
      { proposal_id: sourceId, action: "finalize" },
      { proposal_id: `${sourceId}_sibling`, action: "finalize" },
    ];
    const results = [
      evaluate({ proposal_id: sourceId, action: "revise" }, { source: null }),
      evaluate({
        proposal_id: sourceId,
        action: "revise",
        ask: "[commercially-declined]",
      }),
      evaluate({
        proposal_id: sourceId,
        action: "revise",
        ask: "[unsupported-dimension]",
      }),
      evaluate({
        proposal_id: sourceId,
        action: "revise",
        ask: "Make this somehow better.",
      }),
      evaluate({
        proposal_id: sourceId,
        action: "revise",
        constraints: { total_budget: { currency: "EUR", max: 50_000 } },
      }),
      evaluate(
        { proposal_id: sourceId, action: "revise", alternatives: { count: 3 } },
        {
          profile: "constrained-seller",
        }
      ),
      evaluate(holdBatch[0]!, {
        profile: "finalization-failure",
        refinements: holdBatch,
        index: 0,
      }),
      evaluate(holdBatch[1]!, {
        profile: "finalization-failure",
        refinements: holdBatch,
        index: 1,
      }),
    ];
    expect(
      results.map((result) =>
        "reason_code" in result ? result.reason_code : undefined
      )
    ).toEqual([
      "source_unavailable",
      "commercially_declined",
      "unsupported_dimension",
      "uninterpreted",
      "constraint_unsatisfiable",
      "alternatives_unavailable",
      "hold_unavailable",
      "batch_aborted",
    ]);
  });

  it("uses SDK preflight for the ten-alternative and 25-refinement boundaries", () => {
    expect(() =>
      validateRefineProposalsRequest(
        requestFor([
          {
            proposal_id: "proposal_source_0001",
            action: "revise",
            alternatives: { count: 10 },
          },
        ]),
        TYPED_PROPOSAL_CAPABILITIES
      )
    ).toThrow(/max_alternatives|at most 3/i);

    const twentyFive = Array.from(
      { length: 25 },
      (_, index): ProposalRefinement => ({
        proposal_id: `proposal_boundary_${String(index).padStart(2, "0")}`,
        action: "revise",
        constraints: { total_budget: { currency: "USD", max: 50_000 } },
      })
    );
    expect(() =>
      validateRefineProposalsRequest(
        requestFor(twentyFive),
        TYPED_PROPOSAL_CAPABILITIES
      )
    ).not.toThrow();
    expect(() =>
      validateRefineProposalsRequest(
        requestFor([
          ...twentyFive,
          { proposal_id: "proposal_boundary_25", action: "revise" },
        ]),
        TYPED_PROPOSAL_CAPABILITIES
      )
    ).toThrow(/25/);
  });

  it("rejects missing, wrong-currency, and out-of-policy budgets", () => {
    expect(() =>
      validateRefineProposalsRequest(
        requestFor([
          {
            proposal_id: "proposal_budget_missing_currency",
            action: "revise",
            constraints: {
              total_budget: { max: 50_000 } as {
                currency: string;
                max: number;
              },
            },
          },
        ]),
        TYPED_PROPOSAL_CAPABILITIES
      )
    ).toThrow(/currency/i);

    for (const totalBudget of [
      { currency: "EUR", max: 50_000 },
      { currency: "USD", max: 5_000 },
      { currency: "USD", min: 300_000 },
    ]) {
      const result = evaluate({
        proposal_id: "proposal_budget_policy",
        action: "revise",
        constraints: { total_budget: totalBudget },
      });
      expect(result).toMatchObject({
        outcome: "unable",
        reason_code: "constraint_unsatisfiable",
        unsatisfied_constraints: ["total_budget"],
      });
    }
  });

  it("keeps profile routes dark by default in production and stable elsewhere", () => {
    expect(proposalNegotiationProfilesEnabled({ NODE_ENV: "production" })).toBe(
      false
    );
    expect(
      proposalNegotiationProfilesEnabled({
        NODE_ENV: "production",
        ENABLE_ADCP_3_2_PROPOSAL_PROFILES: "1",
      })
    ).toBe(true);
    expect(proposalNegotiationProfilesEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(
      PROPOSAL_NEGOTIATION_PROFILE_ROUTES.map((route) => route.path)
    ).toEqual([
      "/sales/profiles/typed-negotiation/mcp",
      "/sales/profiles/constrained-seller/mcp",
      "/sales/profiles/finalization-failure/mcp",
    ]);
  });

  it("refines a proposal whose CPA purchase uses a named custom event", async () => {
    const context: TrainingContext = {
      mode: "open",
      tenantId: "sales",
      principal: "typed-profile-custom-event",
      authenticatedAgentUrl: "https://buyer.example",
      proposalNegotiationProfile: "constrained-seller",
    };
    const requested = await executeTrainingAgentTool(
      "request_proposals",
      {
        idempotency_key: "typed-custom-event-request-0001",
        brand: { domain: "buyer.example" },
        brief: "US and Canada display campaign",
      },
      context
    );
    expect(requested.success, requested.error).toBe(true);
    const source = (requested.data?.proposals as CanonicalProposal[])[0]!;
    expect(source.commercial_terms.purchases[0]?.pricing).toMatchObject({
      pricing_model: "cpa",
      event_type: "custom",
      custom_event_name: "agent_session",
    });

    const refined = await executeTrainingAgentTool(
      "refine_proposals",
      {
        idempotency_key: "typed-custom-event-refine-0001",
        refinements: [{
          proposal_id: source.proposal_id,
          action: "revise",
          constraints: { total_budget: { currency: "USD", max: 50_000 } },
          alternatives: { count: 2 },
        }],
      },
      context
    );
    expect(refined.success, refined.error).toBe(true);
    expect(refined.data?.results).toEqual([
      expect.objectContaining({
        outcome: "revised",
        proposals: [expect.any(Object), expect.any(Object)],
      }),
    ]);
    const successors = (refined.data?.results as Array<{
      proposals: CanonicalProposal[];
    }>)[0]!.proposals;
    for (const successor of successors) {
      expect(successor.commercial_terms.purchases[0]?.pricing).toMatchObject({
        event_type: "custom",
        custom_event_name: "agent_session",
      });
    }
  });

  it("executes request, constrained retry, finalize, accept, amendment, and cancellation end to end", async () => {
    const context: TrainingContext = {
      mode: "open",
      tenantId: "sales",
      principal: "typed-profile-integration",
      authenticatedAgentUrl: "https://buyer.example",
      proposalNegotiationProfile: "constrained-seller",
    };
    const brand = { domain: "buyer.example" };
    const account = { brand, operator: "buyer.example" };
    const requested = await executeTrainingAgentTool(
      "request_proposals",
      {
        idempotency_key: "typed-request-proposals-0001",
        brand,
        brief: "social engagement display",
      },
      context
    );
    expect(requested.success, requested.error).toBe(true);
    const requestedProposals = requested.data?.proposals as CanonicalProposal[];
    const source = requestedProposals[0]!;
    expect(requestedProposals.length).toBeGreaterThanOrEqual(2);
    const failedFinalize = await executeTrainingAgentTool(
      "refine_proposals",
      {
        idempotency_key: "typed-atomic-finalize-failure-0001",
        refinements: requestedProposals.slice(0, 2).map((proposal) => ({
          proposal_id: proposal.proposal_id,
          action: "finalize" as const,
        })),
      },
      { ...context, proposalNegotiationProfile: "finalization-failure" }
    );
    expect(failedFinalize.success, failedFinalize.error).toBe(true);
    expect(
      (failedFinalize.data?.results as Array<{ reason_code: string }>).map(
        (result) => result.reason_code
      )
    ).toEqual(["hold_unavailable", "batch_aborted"]);
    const sourceProductIds = new Set(
      source.commercial_terms.purchases.map((entry) => entry.product_id)
    );
    const includedProduct = buildCatalog()
      .map((entry) => entry.product.product_id)
      .find(
        (productId) =>
          !sourceProductIds.has(productId) && !productId.includes("premium")
      );
    expect(includedProduct).toBeTruthy();
    const omittedProduct = source.commercial_terms.purchases[0]!.product_id;
    const threeAlternativeRequest = {
      idempotency_key: "typed-refine-three-0001",
      refinements: [
        {
          proposal_id: source.proposal_id,
          action: "revise" as const,
          constraints: { total_budget: { currency: "USD", max: 50_000 } },
          product_changes: {
            [includedProduct!]: "include" as const,
            [omittedProduct]: "omit" as const,
          },
          criteria: { targeting_overlay: { geo_countries: ["US", "CA"] } },
          alternatives: { count: 3 },
        },
      ],
    };
    const partial = await executeTrainingAgentTool(
      "refine_proposals",
      threeAlternativeRequest,
      context
    );
    expect(partial.success, partial.error).toBe(true);
    expect(partial.data, JSON.stringify(partial.data)).toHaveProperty(
      "results"
    );
    const partialResult = (
      partial.data?.results as Array<Record<string, unknown>>
    )[0]!;
    expect(partialResult).toMatchObject({
      outcome: "partial",
      reason_code: "alternatives_unavailable",
      proposals: [{ proposal_status: "draft" }, { proposal_status: "draft" }],
    });

    const replay = await executeTrainingAgentTool(
      "refine_proposals",
      threeAlternativeRequest,
      context
    );
    expect(replay.success, replay.error).toBe(true);
    expect(replay.data).toMatchObject({
      replayed: true,
      results: partial.data?.results,
    });
    const conflict = await executeTrainingAgentTool(
      "refine_proposals",
      {
        ...threeAlternativeRequest,
        refinements: [
          {
            ...threeAlternativeRequest.refinements[0],
            alternatives: { count: 2 },
          },
        ],
      },
      context
    );
    expect(conflict).toMatchObject({
      success: false,
      error: "IDEMPOTENCY_CONFLICT",
    });

    const selectedDraft = (partialResult.proposals as CanonicalProposal[])[0]!;
    const finalized = await executeTrainingAgentTool(
      "refine_proposals",
      {
        idempotency_key: "typed-finalize-selected-0001",
        refinements: [
          { proposal_id: selectedDraft.proposal_id, action: "finalize" },
        ],
      },
      context
    );
    expect(finalized.success, finalized.error).toBe(true);
    const committed = (
      finalized.data?.results as Array<{ proposal: CanonicalProposal }>
    )[0]!.proposal;
    expect(committed).toMatchObject({
      proposal_status: "committed",
      parent_proposal_id: selectedDraft.proposal_id,
    });

    const accepted = await executeTrainingAgentTool(
      "create_media_buy",
      {
        idempotency_key: "typed-accept-selected-0001",
        account,
        brand,
        proposal_id: committed.proposal_id,
        total_budget: { amount: 50_000, currency: "USD" },
        start_time: committed.commercial_terms.start_time,
        end_time: committed.commercial_terms.end_time,
      },
      context
    );
    expect(accepted.success, accepted.error).toBe(true);
    expect(accepted.data).toMatchObject({
      proposal_id: committed.proposal_id,
      media_buy_id: expect.any(String),
    });

    for (const [changeKind, key] of [
      ["amendment", "typed-amendment-0001"],
      ["cancellation", "typed-cancellation-0001"],
    ] as const) {
      const changed = await executeTrainingAgentTool(
        "refine_proposals",
        {
          idempotency_key: key,
          refinements: [
            {
              proposal_id: committed.proposal_id,
              action: "revise",
              change_kind: changeKind,
              ...(changeKind === "cancellation"
                ? { ask: "Cancel at the next deterministic boundary." }
                : {
                    constraints: {
                      total_budget: { currency: "USD", max: 45_000 },
                    },
                  }),
            },
          ],
        },
        context
      );
      expect(changed.success, changed.error).toBe(true);
      const result = (
        changed.data?.results as Array<{
          outcome: string;
          proposals: CanonicalProposal[];
        }>
      )[0]!;
      expect(result.outcome).toBe("revised");
      expect(result.proposals[0]).toMatchObject({
        parent_proposal_id: committed.proposal_id,
        proposal_kind:
          changeKind === "cancellation"
            ? "media_buy_cancellation"
            : "media_buy_update",
        proposal_status: "draft",
      });
    }
  });
});
