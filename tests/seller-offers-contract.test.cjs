const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

async function compile(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async (ref) => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const DIGEST = "sha256:Fy6Bo7wUa_FmXGJssc37kGyHNjzBiBZLB9rtVNz8I-E";

function terms(extra = {}) {
  return {
    brand: { domain: "acme.example" },
    purchases: [
      {
        product_id: "prod_creator_series",
        pricing_option_id: "po_flat",
        pricing: {
          pricing_option_id: "po_flat",
          pricing_model: "flat_rate",
          currency: "USD",
          fixed_price: 5000,
        },
        start_time: "2026-10-25T00:00:00Z",
        end_time: "2026-11-30T00:00:00Z",
      },
    ],
    start_time: "2026-10-25T00:00:00Z",
    end_time: "2026-11-30T00:00:00Z",
    ...extra,
  };
}

function offer(overrides = {}) {
  return {
    proposal_id: "prop_offer_mb_a_0007",
    proposal_kind: "media_buy_update",
    proposal_initiator: "seller",
    offer_reason: "installment_postponed",
    parent_proposal_id: "prop_accepted_mb_a_0001",
    media_buy_id: "mb_a",
    base_media_buy_revision: 4,
    proposal_status: "committed",
    expires_at: "2026-10-24T17:00:00Z",
    name: "Move the postponed episode to 3 November",
    commercial_terms: terms(),
    terms_digest: DIGEST,
    ...overrides,
  };
}

describe("seller offers (media_buy.seller_offers)", () => {
  let validateProposal;
  let validateWebhook;
  let validateMediaBuys;

  before(async () => {
    [validateProposal, validateWebhook, validateMediaBuys] = await Promise.all([
      compile(readSchema("/schemas/core/canonical-proposal.json")),
      compile(readSchema("/schemas/core/proposal-offered-webhook.json")),
      compile(readSchema("/schemas/media-buy/get-media-buys-response.json")),
    ]);
  });

  describe("canonical-proposal.json", () => {
    it("accepts a committed seller update offer", () => {
      assert.ok(validateProposal(offer()), JSON.stringify(validateProposal.errors));
    });

    it("accepts a committed seller cancellation offer", () => {
      const cancellation = offer({
        proposal_kind: "media_buy_cancellation",
        offer_reason: "installment_cancelled",
        commercial_terms: terms({ cancellation_terms: { effective_at: "2026-10-26T00:00:00Z" } }),
      });
      assert.ok(
        validateProposal(cancellation),
        JSON.stringify(validateProposal.errors)
      );
    });

    it("treats an absent proposal_initiator as buyer", () => {
      const buyer = offer();
      delete buyer.proposal_initiator;
      delete buyer.offer_reason;
      assert.ok(validateProposal(buyer), JSON.stringify(validateProposal.errors));
    });

    it("requires offer_reason on a seller proposal", () => {
      const bad = offer();
      delete bad.offer_reason;
      assert.equal(validateProposal(bad), false);
    });

    it("rejects offer_reason on a buyer proposal", () => {
      assert.equal(validateProposal(offer({ proposal_initiator: "buyer" })), false);
      const implicit = offer();
      delete implicit.proposal_initiator;
      assert.equal(validateProposal(implicit), false);
    });

    it("keeps opportunity_id off a seller offer so accepting it never touches an opportunity", () => {
      assert.equal(validateProposal(offer({ opportunity_id: "opp_1" })), false);
    });

    it("rejects a draft seller proposal", () => {
      assert.equal(validateProposal(offer({ proposal_status: "draft" })), false);
    });

    it("keeps lineage on the accepted snapshot of an offer", () => {
      const accepted = offer({ proposal_status: "accepted", accepted_at: "2026-10-21T09:00:00Z" });
      assert.ok(validateProposal(accepted), JSON.stringify(validateProposal.errors));
      assert.equal(validateProposal({ ...accepted, proposal_status: "draft" }), false);
    });

    it("requires a proposal_id that fits the notification_id pattern", () => {
      assert.equal(validateProposal(offer({ proposal_id: "prop/123" })), false);
      assert.ok(validateProposal(offer({ proposal_id: "prop:123.a-b_c" })));
    });

    it("rejects a seller new_media_buy proposal, which belongs to media_buy.open_opportunities", () => {
      const bad = offer({ proposal_kind: "new_media_buy" });
      for (const field of ["parent_proposal_id", "media_buy_id", "base_media_buy_revision"]) {
        delete bad[field];
      }
      assert.equal(validateProposal(bad), false);
    });

    it("keeps the existing kind conditional requiring the buy lineage", () => {
      for (const field of ["parent_proposal_id", "media_buy_id", "base_media_buy_revision"]) {
        const bad = offer();
        delete bad[field];
        assert.equal(validateProposal(bad), false, field);
      }
    });

    it("closes offer_reason to the five offer values and term_applied", () => {
      const reasons = readSchema("/schemas/enums/offer-reason.json");
      assert.deepEqual(reasons.enum, [
        "installment_postponed",
        "installment_cancelled",
        "preemption",
        "under_delivery",
        "seller_request",
        "term_applied",
      ]);
      assert.deepEqual(Object.keys(reasons.enumDescriptions), reasons.enum);
      assert.equal(validateProposal(offer({ offer_reason: "invented" })), false);
    });

    it("closes proposal_initiator to buyer and seller", () => {
      const initiators = readSchema("/schemas/enums/proposal-initiator.json");
      assert.deepEqual(initiators.enum, ["buyer", "seller"]);
      assert.deepEqual(Object.keys(initiators.enumDescriptions), initiators.enum);
    });

    it("marks the new surface experimental and added in 3.3.0", () => {
      const proposal = readSchema("/schemas/core/canonical-proposal.json");
      for (const field of ["proposal_initiator", "offer_reason"]) {
        assert.equal(proposal.properties[field]["x-status"], "experimental", field);
        assert.equal(proposal.properties[field]["x-added-in"], "3.3.0", field);
      }
      for (const uri of [
        "/schemas/enums/proposal-initiator.json",
        "/schemas/enums/offer-reason.json",
        "/schemas/core/proposal-offered-webhook.json",
      ]) {
        const schema = readSchema(uri);
        assert.equal(schema["x-status"], "experimental", uri);
        assert.equal(schema["x-added-in"], "3.3.0", uri);
      }
    });
  });

  describe("proposal.offered", () => {
    const webhook = () => ({
      idempotency_key: "whk_01K2OFFER4EXAMPLE8Q7M5N3",
      notification_id: "prop_offer_mb_a_0007",
      notification_type: "proposal.offered",
      fired_at: "2026-10-20T14:01:00Z",
      subscriber_id: "buyer-primary",
      account_id: "acc_example",
      media_buy_id: "mb_a",
      proposal_id: "prop_offer_mb_a_0007",
      expires_at: "2026-10-24T17:00:00Z",
      offer_reason: "installment_postponed",
    });

    it("validates the documented payload and every schema example", () => {
      assert.ok(validateWebhook(webhook()), JSON.stringify(validateWebhook.errors));
      const schema = readSchema("/schemas/core/proposal-offered-webhook.json");
      for (const example of schema.examples) {
        assert.ok(validateWebhook(example.data), JSON.stringify(validateWebhook.errors));
      }
    });

    it("requires the repair identifiers and the response deadline", () => {
      for (const field of ["media_buy_id", "proposal_id", "expires_at", "offer_reason", "notification_id"]) {
        const bad = webhook();
        delete bad[field];
        assert.equal(validateWebhook(bad), false, field);
      }
    });

    it("pairs a buy offer only with a buy offer_reason", () => {
      assert.equal(validateWebhook({ ...webhook(), offer_reason: "price_update" }), false);
      assert.ok(validateWebhook({ ...webhook(), offer_reason: "under_delivery" }));
    });

    it("carries no commercial terms on a buy offer", () => {
      assert.equal(validateWebhook({ ...webhook(), commercial_terms: {} }), false);
      assert.equal(validateWebhook({ ...webhook(), opportunity_id: "opp_1" }), false);
      assert.equal(validateWebhook({ ...webhook(), notification_type: "indicators.changed" }), false);
    });

    it("is declared as an account-anchored type and accepted by notification configs", () => {
      const type = readSchema("/schemas/enums/notification-type.json");
      assert.ok(type.enum.includes("proposal.offered"));
      const description = type.enumDescriptions["proposal.offered"];
      for (const marker of ["**anchor**", "**notification_id**", "**repair key**", "**classification**", "list_proposals", "identifiers only"]) {
        assert.ok(description.includes(marker), marker);
      }
      assert.ok(!type.enum.includes("proposal.opportunity_offered"));
      for (const uri of [
        "/schemas/core/notification-config.json",
        "/schemas/core/agent-notification-config.json",
      ]) {
        assert.ok(
          JSON.stringify(readSchema(uri)).includes("proposal.offered"),
          uri
        );
      }
    });
  });

  describe("get_media_buys accepted_proposal for an accepted offer", () => {
    const mediaBuy = () => ({
      media_buy_id: "mb_a",
      status: "active",
      currency: "USD",
      total_budget: 5000,
      confirmed_at: "2026-10-01T00:00:00Z",
      revision: 4,
      packages: [],
    });
    const response = (buy) => ({
      adcp_version: "3.3",
      status: "completed",
      media_buys: [buy],
    });

    it("accepts an accepted seller offer as the buy's accepted_proposal", () => {
      const accepted = offer({
        proposal_status: "accepted",
        accepted_at: "2026-10-21T09:00:00Z",
      });
      const buy = {
        ...mediaBuy(),
        accepted_proposal_id: accepted.proposal_id,
        accepted_proposal_terms_digest: DIGEST,
        accepted_proposal: accepted,
        available_actions: [],
      };
      const ok = validateMediaBuys(response(buy));
      assert.ok(ok, JSON.stringify(validateMediaBuys.errors));
    });
  });

  describe("registry and docs", () => {
    it("lists media_buy.seller_offers in the experimental registry", () => {
      const doc = fs.readFileSync(
        path.join(__dirname, "..", "docs", "reference", "experimental-status.mdx"),
        "utf8"
      );
      assert.match(doc, /\| `media_buy\.seller_offers` \|/);
    });

    it("reads offers through list_proposals and leaves open opportunities to #8103", () => {
      const doc = fs.readFileSync(
        path.join(__dirname, "..", "docs", "media-buy", "product-discovery", "proposal-negotiation.mdx"),
        "utf8"
      );
      const start = doc.indexOf("## Seller offers");
      const section = doc.slice(start, doc.indexOf("## Seller adjustment allowances"));
      assert.match(section, /Dependency \(#8103\)/);
      assert.ok(!/pending #8103/.test(doc));
      assert.match(section, /list_proposals/);
      assert.match(section, /sibling of `proposal\.created`/);
      assert.match(section, /not part of this section/);
      for (const removed of ["accepts_seller_offers", "proposal.opportunity_offered", "offered_proposals"]) {
        assert.ok(!doc.includes(removed), removed);
      }
    });

    it("documents seller offers where buyers negotiate", () => {
      const doc = fs.readFileSync(
        path.join(__dirname, "..", "docs", "media-buy", "product-discovery", "proposal-negotiation.mdx"),
        "utf8"
      );
      assert.match(doc, /## Seller offers/);
      assert.match(doc, /silence never equals acceptance|Silence never equals acceptance/i);
    });

    it("lapses an offer to expired with PROPOSAL_EXPIRED, never as declined", () => {
      const read = (...parts) =>
        fs.readFileSync(path.join(__dirname, "..", "docs", ...parts), "utf8");
      const accept = read("media-buy", "task-reference", "accept_proposal.mdx");
      const registry = read("reference", "experimental-status.mdx");
      const negotiation = read("media-buy", "product-discovery", "proposal-negotiation.mdx");
      assert.match(accept, /disposition is `expired`, and `accept_proposal` returns \[`PROPOSAL_EXPIRED`\]/);
      assert.match(accept, /`withdrawn` snapshot returns \[`INVALID_STATE`\]/);
      assert.match(negotiation, /disposition `expired`/);
      for (const doc of [accept, registry, negotiation]) {
        assert.ok(!/lapsed? as declined|lapse-as-declined/.test(doc));
      }
      const disposition = readSchema("/schemas/enums/proposal-disposition.json");
      assert.ok(disposition.enum.includes("expired") && disposition.enum.includes("withdrawn"));
    });
  });


  describe("seller-held change terms (media_buy.seller_adjustment_allowances)", () => {
    let validateTerm;
    let validateConstraints;
    let validateApplied;
    let validateAppliedWebhook;
    let validateTerms;

    const money = (amount) => ({ amount, currency: "USD" });
    const budgetTerm = (extra = {}) => ({
      term_id: "release_budget_1",
      holder: "seller",
      purchase_index: 0,
      action: "decrease_budget",
      constraints: { kind: "budget", min_result_amount: money(4000) },
      ...extra,
    });
    const flightTerm = (extra = {}) => ({
      term_id: "shift_flight_1",
      holder: "seller",
      purchase_index: 0,
      action: "update_flight_dates",
      constraints: {
        kind: "flight",
        latest_result: "2026-12-03T00:00:00Z",
        minimum_notice: { interval: 24, unit: "hours" },
      },
      ...extra,
    });
    const volumeTerm = (extra = {}) => ({
      term_id: "cut_goal_1",
      holder: "seller",
      purchase_index: 0,
      action: "update_impression_goal",
      constraints: { kind: "volume", min_result_impressions: 800000 },
      ...extra,
    });
    const alternatesTerm = (extra = {}) => ({
      term_id: "line_alternates_1",
      holder: "seller",
      purchase_index: 0,
      action: "update_targeting",
      constraints: {
        kind: "alternates",
        alternates: [
          {
            label: "Quiz Night",
            targeting_overlay: {
              collection_selection: {
                mode: "selected",
                collections: [{ publisher_domain: "network.example", collection_ids: ["quiz_night"] }],
              },
            },
          },
        ],
      },
      ...extra,
    });
    const buyerTerm = (extra = {}) => ({
      term_id: "buyer_budget_up",
      action: "increase_budget",
      service_mode: "seller_managed",
      ...extra,
    });
    const applied = (extra = {}) => ({
      adjustment_id: "adj_mb_a_0003",
      term_id: "release_budget_1",
      revision: 6,
      accepted_proposal_id: "prop_accepted_mb_a_0006",
      applied_at: "2026-11-12T09:30:00Z",
      reason: "forecast_shortfall",
      purchase_index: 0,
      action: "decrease_budget",
      previous_value: 5000,
      value: 4600,
      ...extra,
    });
    const docText = (...parts) =>
      fs.readFileSync(path.join(__dirname, "..", "docs", ...parts), "utf8");

    before(async () => {
      [validateTerm, validateConstraints, validateApplied, validateAppliedWebhook, validateTerms] =
        await Promise.all([
          compile(readSchema("/schemas/media-buy/change-term.json")),
          compile(readSchema("/schemas/media-buy/change-term-constraints.json")),
          compile(readSchema("/schemas/core/applied-seller-adjustment.json")),
          compile(readSchema("/schemas/core/allowance-applied-webhook.json")),
          compile(readSchema("/schemas/media-buy/commercial-terms.json")),
        ]);
    });

    it("reuses change_terms[] and leaves no parallel vocabulary", () => {
      for (const term of [budgetTerm(), flightTerm(), volumeTerm(), alternatesTerm()]) {
        assert.ok(validateTerm(term), JSON.stringify(validateTerm.errors));
      }
      for (const removed of [
        ["core", "seller-adjustable-term.json"],
        ["enums", "adjustment-direction.json"],
        ["enums", "seller-adjustment-kind.json"],
      ]) {
        assert.ok(!fs.existsSync(path.join(SCHEMA_ROOT, ...removed)), removed.join("/"));
      }
      const terms = readSchema("/schemas/media-buy/commercial-terms.json");
      assert.equal(terms.properties.seller_adjustable_terms, undefined);
      assert.equal(validateTerms(terms_(budgetTerm())), true);
      assert.equal(validateTerms(terms_(budgetTerm(), "seller_adjustable_terms")), false);
      const schema = readSchema("/schemas/media-buy/change-term.json");
      assert.equal(schema.properties.holder.default, "buyer");
      assert.deepEqual(schema.properties.holder.enum, ["buyer", "seller"]);
      assert.equal(schema.properties.purchase_index.minimum, 0);
      for (const field of ["holder", "purchase_index"]) {
        assert.equal(schema.properties[field]["x-status"], "experimental", field);
        assert.equal(schema.properties[field]["x-added-in"], "3.3.0", field);
      }
    });

    function terms_(term, field = "change_terms") {
      return terms({ [field]: [term] });
    }

    it("keeps a term without holder a buyer right exactly as before", () => {
      assert.ok(validateTerm(buyerTerm()), JSON.stringify(validateTerm.errors));
      assert.ok(validateTerm(buyerTerm({ holder: "buyer", purchase_index: 1 })));
      const noMode = buyerTerm();
      delete noMode.service_mode;
      assert.equal(validateTerm(noMode), false, "a buyer-held term still requires service_mode");
      assert.equal(validateTerm({ ...buyerTerm(), holder: "operator" }), false);
      assert.equal(
        validateTerm(
          buyerTerm({ constraints: { kind: "alternates", alternates: alternatesTerm().constraints.alternates } })
        ),
        false,
        "alternates are seller-held only"
      );
    });

    it("limits a seller-held term to four actions, a purchase, and no buyer routing fields", () => {
      for (const action of ["pause", "increase_budget", "extend_flight", "cancel", "update_pacing", "add_packages"]) {
        assert.equal(validateTerm(budgetTerm({ action })), false, action);
      }
      for (const field of ["purchase_index", "constraints"]) {
        const bad = budgetTerm();
        delete bad[field];
        assert.equal(validateTerm(bad), false, field);
      }
      assert.equal(validateTerm(budgetTerm({ service_mode: "seller_managed" })), false);
      assert.equal(validateTerm(budgetTerm({ processing_sla: { response_max: { interval: 1, unit: "hours" } } })), false);
      assert.equal(validateTerm(budgetTerm({ purchase_index: -1 })), false);
    });

    it("requires one absolute bound per seller-held term and rejects relative bounds", () => {
      const budget = (constraints) => validateTerm(budgetTerm({ constraints }));
      assert.equal(budget({ kind: "budget", max_delta_percent: 20 }), false);
      assert.equal(budget({ kind: "budget", max_delta_amount: money(400) }), false);
      assert.equal(budget({ kind: "budget", max_result_amount: money(4000) }), false);
      assert.equal(budget({ kind: "budget", min_result_amount: money(4000), max_delta_percent: 20 }), false);
      assert.equal(budget({ kind: "budget", min_result_amount: money(4000), max_delta_amount: money(400) }), false);
      assert.equal(budget({ kind: "flight", latest_result: "2026-12-03T00:00:00Z" }), false);
      assert.equal(budget({}), false);

      const flight = (constraints) => validateTerm(flightTerm({ constraints }));
      assert.equal(flight({ kind: "flight", max_change: { interval: 2, unit: "days" } }), false);
      assert.equal(flight({ kind: "flight", minimum_notice: { interval: 1, unit: "days" } }), false);
      assert.equal(
        flight({ kind: "flight", earliest_result: "2026-10-25T00:00:00Z", max_change: { interval: 2, unit: "days" } }),
        false
      );
      assert.ok(flight({ kind: "flight", earliest_result: "2026-10-25T00:00:00Z" }));
      assert.ok(flight({ kind: "flight", earliest_result: "2026-10-25T00:00:00Z", latest_result: "2026-12-03T00:00:00Z" }));

      const volume = (constraints) => validateTerm(volumeTerm({ constraints }));
      assert.equal(volume({ kind: "volume", max_result_impressions: 900000 }), false);
      assert.equal(volume({ kind: "volume", min_result_impressions: 800000, max_result_impressions: 900000 }), false);
      assert.equal(volume({ kind: "budget", min_result_amount: money(4000) }), false);

      const alternates = (constraints) => validateTerm(alternatesTerm({ constraints }));
      assert.equal(alternates({ kind: "alternates", alternates: [] }), false);
      assert.equal(alternates({ kind: "alternates" }), false);
      assert.equal(alternates({ kind: "alternates", alternates: [{ label: "no overlay" }] }), false);
      assert.equal(alternates({ kind: "budget", min_result_amount: money(4000) }), false);
      assert.equal(validateTerm(alternatesTerm({ action: "decrease_budget" })), false, "alternates fit update_targeting only");
    });

    it("keeps the new constraint kinds closed and out of any base-relative form", () => {
      assert.ok(validateConstraints({ kind: "volume", min_result_impressions: 1 }));
      assert.ok(validateConstraints({ kind: "volume", max_result_impressions: 1 }), "buyer-held volume bounds stay usable");
      assert.equal(validateConstraints({ kind: "volume" }), false);
      assert.equal(validateConstraints({ kind: "volume", min_result_impressions: -1 }), false);
      assert.equal(validateConstraints({ kind: "volume", min_result_impressions: 1, max_delta_percent: 5 }), false);
      assert.equal(validateConstraints({ ...alternatesTerm().constraints, direction: "later" }), false);
      assert.equal(validateConstraints({ ...alternatesTerm().constraints, max_change_fraction: 0.2 }), false);
      const text = JSON.stringify(readSchema("/schemas/media-buy/change-term-constraints.json"));
      for (const removed of ["max_change_fraction", "max_shift", "cumulative_change"]) {
        assert.ok(!text.includes(removed), removed);
      }
      const verifier = readSchema("/schemas/media-buy/change-term.json")["x-adcp-validation"].verifier_constraints;
      assert.deepEqual(verifier.constraint_action_compatibility.volume, ["update_impression_goal"]);
      assert.deepEqual(verifier.constraint_action_compatibility.alternates, ["update_targeting"]);
    });

    it("rides commercial_terms.change_terms and is covered by the terms digest", () => {
      assert.ok(
        validateTerms(
          terms({ change_terms: [buyerTerm(), budgetTerm(), flightTerm(), volumeTerm(), alternatesTerm()] })
        ),
        JSON.stringify(validateTerms.errors)
      );
      const field = readSchema("/schemas/media-buy/commercial-terms.json").properties.change_terms;
      assert.deepEqual(field["x-adcp-validation"].unique_by, ["holder", "purchase_index", "action"]);
      assert.equal(field["x-adcp-validation"].verifier_constraints.change_term_ids, "term_id_unique_across_holders");
      assert.match(field.description, /MUST NOT emit a seller-held term below AdCP 3\.3/);
      const bounds = readSchema("/schemas/media-buy/change-term.json")["x-adcp-validation"].verifier_constraints.seller_held_terms;
      assert.equal(bounds.purchase_index, "less_than_purchases_length_and_preserved_by_amendments");
      assert.match(bounds.bounds, /at_least_one_absolute_result_bound/);
      assert.match(bounds.flight_length, /never_lengthens_time_priced_or_shortens_flat_rate_purchase/);
      assert.match(bounds.total_budget, /decreases_total_budget_when_present_by_same_amount/);
      assert.match(bounds.alternates, /never_raises_spend/);
    });

    it("keeps seller-held terms off cancellation proposals but not buyer-held ones", () => {
      const cancellation = (change_terms) =>
        offer({
          proposal_kind: "media_buy_cancellation",
          offer_reason: "seller_request",
          commercial_terms: terms({
            cancellation_terms: { effective_at: "2026-10-26T00:00:00Z" },
            change_terms,
          }),
        });
      assert.equal(validateProposal(cancellation([budgetTerm()])), false);
      assert.ok(validateProposal(cancellation([buyerTerm()])), JSON.stringify(validateProposal.errors));
    });

    it("mints an accepted term_applied successor, never a committed offer", () => {
      const successor = (extra = {}) =>
        offer({
          proposal_id: "prop_accepted_mb_a_0006",
          offer_reason: "term_applied",
          proposal_status: "accepted",
          accepted_at: "2026-11-12T09:30:00Z",
          base_media_buy_revision: 5,
          ...extra,
        });
      const ok = successor();
      delete ok.expires_at;
      assert.ok(validateProposal(ok), JSON.stringify(validateProposal.errors));
      assert.equal(validateProposal(successor({ proposal_status: "committed" })), false);
      assert.equal(
        validateProposal(successor({ proposal_kind: "media_buy_cancellation" })),
        false,
        "an application is never a cancellation"
      );
      assert.equal(validateWebhook({
        idempotency_key: "whk_01K2OFFER4EXAMPLE8Q7M5N3",
        notification_id: "prop_accepted_mb_a_0006",
        notification_type: "proposal.offered",
        fired_at: "2026-11-12T09:30:00Z",
        subscriber_id: "buyer-primary",
        account_id: "acc_example",
        media_buy_id: "mb_a",
        proposal_id: "prop_accepted_mb_a_0006",
        expires_at: "2026-11-13T09:30:00Z",
        offer_reason: "term_applied",
      }), false, "proposal.offered never announces an application");
    });

    it("validates an applied adjustment for a number, a flight, and an alternate", () => {
      assert.ok(validateApplied(applied()), JSON.stringify(validateApplied.errors));
      assert.ok(
        validateApplied(
          applied({
            adjustment_id: "adj_mb_a_0004",
            term_id: "shift_flight_1",
            action: "update_flight_dates",
            previous_value: { start_time: "2026-11-19T01:00:00Z", end_time: "2026-11-30T00:00:00Z" },
            value: { start_time: "2026-11-20T01:00:00Z", end_time: "2026-11-30T00:00:00Z" },
          })
        ),
        JSON.stringify(validateApplied.errors)
      );
      assert.ok(
        validateApplied(
          applied({
            adjustment_id: "adj_mb_a_0005",
            term_id: "line_alternates_1",
            action: "update_targeting",
            previous_value: { collection_selection: { mode: "selected" } },
            value: { collection_selection: { mode: "selected" } },
            alternate_index: 1,
            skipped_alternates: [{ alternate_index: 0, reason: "Preempted" }],
          })
        ),
        JSON.stringify(validateApplied.errors)
      );
      const schema = readSchema("/schemas/core/applied-seller-adjustment.json");
      for (const example of schema.examples) {
        assert.ok(validateApplied(example.data), JSON.stringify(validateApplied.errors));
      }
    });

    it("requires the term, the successor and both values, and drops base-relative fields", () => {
      for (const field of ["action", "previous_value", "value", "reason", "term_id", "revision", "accepted_proposal_id"]) {
        const bad = applied();
        delete bad[field];
        assert.equal(validateApplied(bad), false, field);
      }
      for (const removed of [{ allowance_id: "x" }, { path: "/budget" }, { cumulative_change: 400 }, { kind: "budget_release" }]) {
        assert.equal(validateApplied(applied(removed)), false, Object.keys(removed)[0]);
      }
      assert.equal(validateApplied(applied({ action: "pause" })), true, "action is the canonical vocabulary");
      assert.equal(validateApplied(applied({ action: "invented" })), false);
      assert.equal(validateApplied(applied({ reason: "Forecast shortfall" })), false);
      assert.equal(validateApplied(applied({ skipped_alternates: [{ alternate_index: 0, reason: "x" }] })), false);
    });

    it("lists applied_adjustments and tags history with the term origin", () => {
      const buy = (extra, history) => ({
        media_buy_id: "mb_a",
        status: "active",
        currency: "USD",
        total_budget: 4600,
        confirmed_at: "2026-10-01T00:00:00Z",
        revision: 6,
        packages: [],
        ...extra,
        ...(history ? { history } : {}),
      });
      const response = (b) => ({ adcp_version: "3.3", status: "completed", media_buys: [b] });
      const entry = {
        revision: 6,
        timestamp: "2026-11-12T09:30:00Z",
        action: "updated_budget",
        actor: "seller_system",
        term_id: "release_budget_1",
        reason: "forecast_shortfall",
        summary: "Released 400 USD that the forecast says cannot be delivered",
      };
      assert.ok(
        validateMediaBuys(response(buy({ applied_adjustments: [applied()] }, [entry]))),
        JSON.stringify(validateMediaBuys.errors)
      );
      const noReason = { ...entry };
      delete noReason.reason;
      assert.equal(validateMediaBuys(response(buy({}, [noReason]))), false);
      const noActor = { ...entry };
      delete noActor.actor;
      assert.equal(validateMediaBuys(response(buy({}, [noActor]))), false);
      assert.ok(validateMediaBuys(response(buy({}, [{ ...entry, actor: "seller_operator" }]))));
      for (const actor of ["adcp", "connected_platform", "buyer", "ops@seller.example"]) {
        assert.equal(validateMediaBuys(response(buy({}, [{ ...entry, actor }]))), false, actor);
      }
      assert.equal(validateMediaBuys(response(buy({}, [{ ...entry, reason: "Forecast shortfall" }]))), false);
    });

    it("reuses the account change feed origin vocabulary instead of a separate one", () => {
      const origin = readSchema("/schemas/core/account-change.json").properties.origin.properties.kind.enum;
      assert.ok(origin.includes("seller_system") && origin.includes("seller_operator"));
      assert.ok(!fs.existsSync(path.join(SCHEMA_ROOT, "enums", "change-origin.json")));
      const text = docText("media-buy", "product-discovery", "proposal-negotiation.mdx");
      assert.ok(!text.includes("change_origin"));
      assert.match(text, /`origin\.kind` values of the account change feed/);
      const change = readSchema("/schemas/core/account-change.json").properties.term_id;
      assert.equal(change["x-status"], "experimental");
      assert.equal(change["x-added-in"], "3.3.0");
      assert.equal(change["x-entity"], "media_buy_change_term");
    });

    it("announces an applied adjustment through media_buy.allowance_applied", () => {
      const schema = readSchema("/schemas/core/allowance-applied-webhook.json");
      for (const example of schema.examples) {
        assert.ok(validateAppliedWebhook(example.data), JSON.stringify(validateAppliedWebhook.errors));
      }
      const data = schema.examples[0].data;
      assert.equal(validateAppliedWebhook({ ...data, value: 4600 }), false);
      assert.equal(validateAppliedWebhook({ ...data, kind: "budget_release" }), false);
      assert.equal(validateAppliedWebhook({ ...data, path: "/budget" }), false);
      for (const field of ["action", "term_id"]) {
        const bad = { ...data };
        delete bad[field];
        assert.equal(validateAppliedWebhook(bad), false, field);
      }
      const type = readSchema("/schemas/enums/notification-type.json");
      assert.ok(type.enum.includes("media_buy.allowance_applied"));
      const description = type.enumDescriptions["media_buy.allowance_applied"];
      for (const marker of ["**anchor**", "**notification_id**", "**repair key**", "**classification**", "get_media_buys", "change_terms[]"]) {
        assert.ok(description.includes(marker), marker);
      }
      for (const uri of [
        "/schemas/core/notification-config.json",
        "/schemas/core/agent-notification-config.json",
      ]) {
        assert.ok(JSON.stringify(readSchema(uri)).includes("media_buy.allowance_applied"), uri);
      }
    });

    it("marks every new surface experimental and added in 3.3.0, with a registry row", () => {
      for (const uri of [
        "/schemas/core/applied-seller-adjustment.json",
        "/schemas/core/allowance-applied-webhook.json",
      ]) {
        const schema = readSchema(uri);
        assert.equal(schema["x-status"], "experimental", uri);
        assert.equal(schema["x-added-in"], "3.3.0", uri);
      }
      const constraints = readSchema("/schemas/media-buy/change-term-constraints.json");
      const kinds = Object.fromEntries(constraints.oneOf.map((k) => [k.properties.kind.const, k]));
      for (const kind of ["volume", "alternates"]) {
        assert.equal(kinds[kind]["x-status"], "experimental", kind);
        assert.equal(kinds[kind]["x-added-in"], "3.3.0", kind);
      }
      const doc = docText("reference", "experimental-status.mdx");
      assert.match(doc, /\| `media_buy\.seller_adjustment_allowances` \|/);
      assert.ok(!doc.includes("seller_adjustable_terms"));
      assert.ok(!doc.includes("adjustment-direction"));
    });

    it("validates every worked example in the docs against change-term.json", () => {
      const text = docText("media-buy", "product-discovery", "proposal-negotiation.mdx");
      const section = text.slice(
        text.indexOf("### Worked example: budget release"),
        text.indexOf("### Applied adjustments are visible and auditable")
      );
      const examples = [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
      assert.deepEqual(
        examples.map((e) => e.action),
        ["decrease_budget", "update_flight_dates", "update_targeting"]
      );
      for (const example of examples) {
        assert.equal(example.holder, "seller");
        assert.ok(validateTerm(example), JSON.stringify(validateTerm.errors));
      }
    });

    it("documents the shared vocabulary, who authors the terms, and what is out of scope", () => {
      const text = docText("media-buy", "product-discovery", "proposal-negotiation.mdx");
      const section = text.slice(
        text.indexOf("## Seller adjustment allowances"),
        text.indexOf("## Seller implementation")
      );
      for (const marker of [
        "`holder`",
        "`purchase_index`",
        "Worked example: budget release",
        "Worked example: schedule shift and line alternates",
        "The seller states in the committed terms which fields it may change, and the buyer binds them through `accept_proposal`",
        "absolute",
        "A seller MUST NOT lengthen a purchase whose `pricing_model` is `time`, or shorten one whose `pricing_model` is `flat_rate`",
        "Decreasing a purchase `budget` decreases `total_budget`, when present, by the same amount",
        "mints an accepted successor proposal",
        "makes every committed proposal against the prior revision stale, whichever party initiated it",
        "delivered-to-date plus in-flight",
        "$0 make-good package",
        "seller_system",
      ]) {
        assert.ok(section.includes(marker), marker);
      }
      for (const removed of ["seller_adjustable_terms", "max_change_fraction", "max_shift", "cumulative_change", "`direction`"]) {
        assert.ok(!text.includes(removed), removed);
      }
      assert.ok(!/The buyer declares in `commercial_terms/.test(text));
      assert.ok(!/buyer pre-authorizes|buyer pre-authorized/.test(section));
      assert.ok(!/`(budget_release|schedule_shift)` \|/.test(section));
    });
  });
});
