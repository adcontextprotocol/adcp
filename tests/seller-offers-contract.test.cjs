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

    it("closes offer_reason to the five declared values", () => {
      const reasons = readSchema("/schemas/enums/offer-reason.json");
      assert.deepEqual(reasons.enum, [
        "installment_postponed",
        "installment_cancelled",
        "preemption",
        "under_delivery",
        "seller_request",
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
      assert.match(section, /pending #8103/);
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
  });

  describe("seller adjustable terms (media_buy.seller_adjustment_allowances)", () => {
    let validateTerm;
    let validateApplied;
    let validateAppliedWebhook;
    let validateTerms;

    const budgetTerm = (extra = {}) => ({
      allowance_id: "allow_release_1",
      purchase_index: 0,
      path: "/budget",
      constraint: { direction: "decrease", max_change_fraction: 0.2 },
      min_notice: { interval: 7, unit: "days" },
      ...extra,
    });
    const shiftTerm = (extra = {}) => ({
      allowance_id: "allow_shift_1",
      purchase_index: 0,
      path: "/start_time",
      constraint: { direction: "later", max_shift: { interval: 2, unit: "days" } },
      min_notice: { interval: 24, unit: "hours" },
      ...extra,
    });
    const alternatesTerm = (extra = {}) => ({
      allowance_id: "allow_alt_1",
      purchase_index: 0,
      path: "/targeting_overlay/collection_selection",
      constraint: {
        alternates: [
          { label: "Quiz Night", value: { mode: "selected", collections: [{ publisher_domain: "network.example", collection_ids: ["quiz_night"] }] } },
        ],
      },
      ...extra,
    });
    const applied = (extra = {}) => ({
      adjustment_id: "adj_mb_a_0003",
      allowance_id: "allow_release_1",
      revision: 6,
      applied_at: "2026-11-12T09:30:00Z",
      reason: "forecast_shortfall",
      purchase_index: 0,
      path: "/budget",
      previous_value: 5000,
      value: 4600,
      cumulative_change: 400,
      ...extra,
    });

    before(async () => {
      [validateTerm, validateApplied, validateAppliedWebhook, validateTerms] =
        await Promise.all([
          compile(readSchema("/schemas/core/seller-adjustable-term.json")),
          compile(readSchema("/schemas/core/applied-seller-adjustment.json")),
          compile(readSchema("/schemas/core/allowance-applied-webhook.json")),
          compile(readSchema("/schemas/media-buy/commercial-terms.json")),
        ]);
    });

    it("expresses budget release, a schedule shift and line alternates with one mechanism", () => {
      for (const term of [budgetTerm(), shiftTerm(), alternatesTerm()]) {
        assert.ok(validateTerm(term), JSON.stringify(validateTerm.errors));
      }
      const schema = readSchema("/schemas/core/seller-adjustable-term.json");
      assert.equal(schema.properties.kind, undefined);
      assert.ok(!fs.existsSync(path.join(SCHEMA_ROOT, "enums", "seller-adjustment-kind.json")));
    });

    it("requires allowance_id, purchase_index, path and a non-empty constraint", () => {
      for (const field of ["allowance_id", "purchase_index", "path", "constraint"]) {
        const bad = budgetTerm();
        delete bad[field];
        assert.equal(validateTerm(bad), false, field);
      }
      assert.equal(validateTerm(budgetTerm({ constraint: {} })), false);
      assert.equal(validateTerm(budgetTerm({ constraint: { unknown_bound: 1 } })), false);
    });

    it("takes only pointers into allowed purchase members, never a root, price or self-referencing path", () => {
      const bad = [
        "budget", "/budget~2", "", "/", "/pricing", "/pricing/fixed_price", "/pricing_option_id", "/product_id",
        "/purchases/0/pricing/fixed_price", "/purchases/0/budget", "/seller_adjustable_terms/0/constraint",
        "/cancellation_terms", "/definition_pins", "/total_budget/amount", "/brand",
        "/measurement_terms", "/performance_standards", "/bidding", "/optimization_goals", "/daily_budget_cap",
        "/targeting_overlay/daypart_targets/0", "/targeting_overlay/-", "/budgetx",
      ];
      for (const p of bad) {
        assert.equal(validateTerm(alternatesTerm({ path: p })), false, p);
      }
      for (const p of ["/targeting_overlay", "/targeting_overlay/daypart_targets", "/targeting_overlay/a~1b"]) {
        assert.ok(validateTerm(alternatesTerm({ path: p })), p);
      }
    });

    it("makes budget and impressions decrease-only", () => {
      for (const path of ["/budget", "/impressions"]) {
        assert.ok(validateTerm(budgetTerm({ path })), path);
        assert.equal(validateTerm(budgetTerm({ path, constraint: { direction: "increase" } })), false, path);
        assert.equal(validateTerm(budgetTerm({ path, constraint: { max_change_fraction: 0.1 } })), false, `${path} needs direction`);
        assert.equal(validateTerm(budgetTerm({ path, constraint: { direction: "decrease", max_shift: { interval: 1, unit: "days" } } })), false, path);
        assert.equal(validateTerm(budgetTerm({ path, constraint: { direction: "decrease", alternates: [{ value: 1 }] } })), false, path);
      }
      assert.ok(validateTerm(budgetTerm({ constraint: { direction: "decrease", min: 1000, max_change_fraction: 0.5 } })));
    });

    it("limits timestamps to earlier or later with a shift and requires min_notice", () => {
      assert.ok(validateTerm(shiftTerm()));
      assert.ok(validateTerm(shiftTerm({ path: "/end_time", constraint: { direction: "earlier", max_shift: { interval: 1, unit: "days" } }, min_notice: { interval: 1, unit: "days" } })));
      const noNotice = shiftTerm();
      delete noNotice.min_notice;
      assert.equal(validateTerm(noNotice), false);
      assert.equal(validateTerm(shiftTerm({ min_notice: { interval: 1, unit: "days" }, constraint: { direction: "decrease", max_shift: { interval: 1, unit: "days" } } })), false);
      assert.equal(validateTerm(shiftTerm({ min_notice: { interval: 1, unit: "days" }, constraint: { max_change_fraction: 0.1 } })), false);
      assert.equal(validateTerm(shiftTerm({ min_notice: { interval: 1, unit: "days" }, constraint: { max_shift: { interval: 1, unit: "campaign" } } })), false);
      assert.equal(validateTerm(shiftTerm({ min_notice: { interval: 1, unit: "campaign" } })), false);
    });

    it("limits targeting_overlay to alternates", () => {
      assert.ok(validateTerm(alternatesTerm()));
      assert.equal(validateTerm(alternatesTerm({ constraint: { direction: "decrease" } })), false);
      assert.equal(validateTerm(alternatesTerm({ constraint: { max_shift: { interval: 1, unit: "days" } } })), false);
      assert.equal(validateTerm(alternatesTerm({ constraint: { alternates: [{ value: undefined }] } })), false);
    });

    it("bounds the constraint members", () => {
      assert.ok(validateTerm(budgetTerm({ constraint: { direction: "decrease", max_change_fraction: 1 } })));
      assert.equal(validateTerm(budgetTerm({ constraint: { direction: "decrease", max_change_fraction: 0 } })), false);
      assert.equal(validateTerm(budgetTerm({ constraint: { direction: "decrease", max_change_fraction: 1.5 } })), false);
      assert.equal(validateTerm(budgetTerm({ constraint: { direction: "sideways" } })), false);
      assert.equal(validateTerm(alternatesTerm({ constraint: { alternates: [] } })), false);
      assert.equal(validateTerm(alternatesTerm({ constraint: { alternates: [{ label: "no value" }] } })), false);
      const directions = readSchema("/schemas/enums/adjustment-direction.json");
      assert.deepEqual(directions.enum, ["decrease", "increase", "earlier", "later"]);
      assert.deepEqual(Object.keys(directions.enumDescriptions), directions.enum);
    });

    it("rides commercial_terms and is covered by the terms digest", () => {
      assert.ok(
        validateTerms(terms({ seller_adjustable_terms: [budgetTerm(), shiftTerm(), alternatesTerm()] })),
        JSON.stringify(validateTerms.errors)
      );
      assert.equal(validateTerms(terms({ seller_adjustable_terms: [] })), false);
      assert.equal(validateTerms(terms({ seller_adjustment_allowances: [budgetTerm()] })), false);
      const field = readSchema("/schemas/media-buy/commercial-terms.json").properties.seller_adjustable_terms;
      assert.equal(field["x-status"], "experimental");
      assert.equal(field["x-added-in"], "3.3.0");
      assert.equal(field["x-adcp-validation"].unique_by, "allowance_id");
      const bounds = field["x-adcp-validation"].verifier_constraints.adjustable_term_bounds;
      assert.equal(bounds.purchase_index, "less_than_purchases_length");
      assert.equal(bounds.one_entry_per_purchase_index_and_path, true);
      assert.equal(bounds.canonical_order, "ascending_allowance_id");
      assert.match(bounds.flight_length, /never_lengthened/);
      assert.match(bounds.alternates, /never_raise_spend/);
      assert.match(field.description, /pinned below AdCP 3\.3/);
    });

    it("keeps terms off cancellation proposals", () => {
      const cancellation = offer({
        proposal_kind: "media_buy_cancellation",
        offer_reason: "seller_request",
        commercial_terms: terms({
          cancellation_terms: { effective_at: "2026-10-26T00:00:00Z" },
          seller_adjustable_terms: [budgetTerm()],
        }),
      });
      assert.equal(validateProposal(cancellation), false);
    });

    it("validates an applied adjustment for a number, a timestamp and an alternate", () => {
      assert.ok(validateApplied(applied()), JSON.stringify(validateApplied.errors));
      const shifted = applied({
        adjustment_id: "adj_mb_a_0004",
        allowance_id: "allow_shift_1",
        path: "/start_time",
        previous_value: "2026-11-19T01:00:00Z",
        value: "2026-11-20T01:00:00Z",
      });
      delete shifted.cumulative_change;
      assert.ok(validateApplied(shifted), JSON.stringify(validateApplied.errors));
      const alternate = applied({
        adjustment_id: "adj_mb_a_0005",
        allowance_id: "allow_alt_1",
        path: "/targeting_overlay/collection_selection",
        previous_value: { mode: "selected", collections: [{ publisher_domain: "network.example", collection_ids: ["primary"] }] },
        value: { mode: "selected", collections: [{ publisher_domain: "network.example", collection_ids: ["quiz_night"] }] },
        alternate_index: 1,
        skipped_alternates: [{ alternate_index: 0, reason: "Preempted" }],
      });
      delete alternate.cumulative_change;
      assert.ok(validateApplied(alternate), JSON.stringify(validateApplied.errors));
    });

    it("requires the path and both values on an applied adjustment", () => {
      for (const field of ["path", "previous_value", "value", "reason", "allowance_id", "revision"]) {
        const bad = applied();
        delete bad[field];
        assert.equal(validateApplied(bad), false, field);
      }
      assert.equal(validateApplied(applied({ kind: "budget_release" })), false);
      assert.equal(validateApplied(applied({ reason: "Forecast shortfall" })), false);
      assert.equal(validateApplied(applied({ skipped_alternates: [{ alternate_index: 0, reason: "x" }] })), false);
    });

    it("lists applied_adjustments and tags history with the allowance origin", () => {
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
        allowance_id: "allow_release_1",
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
      const text = fs.readFileSync(
        path.join(__dirname, "..", "docs", "media-buy", "product-discovery", "proposal-negotiation.mdx"),
        "utf8"
      );
      assert.ok(!text.includes("change_origin"));
      assert.match(text, /`origin\.kind` values of the account change feed/);
      const change = readSchema("/schemas/core/account-change.json").properties.allowance_id;
      assert.equal(change["x-status"], "experimental");
      assert.equal(change["x-added-in"], "3.3.0");
      assert.equal(change["x-entity"], "seller_adjustment_allowance");
    });

    it("announces an applied adjustment through media_buy.allowance_applied", () => {
      const schema = readSchema("/schemas/core/allowance-applied-webhook.json");
      for (const example of schema.examples) {
        assert.ok(validateAppliedWebhook(example.data), JSON.stringify(validateAppliedWebhook.errors));
      }
      const data = schema.examples[0].data;
      assert.equal(validateAppliedWebhook({ ...data, value: 4600 }), false);
      assert.equal(validateAppliedWebhook({ ...data, kind: "budget_release" }), false);
      const noPath = { ...data };
      delete noPath.path;
      assert.equal(validateAppliedWebhook(noPath), false);
      const type = readSchema("/schemas/enums/notification-type.json");
      assert.ok(type.enum.includes("media_buy.allowance_applied"));
      const description = type.enumDescriptions["media_buy.allowance_applied"];
      for (const marker of ["**anchor**", "**notification_id**", "**repair key**", "**classification**", "get_media_buys", "seller_adjustable_terms"]) {
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
        "/schemas/enums/adjustment-direction.json",
        "/schemas/core/seller-adjustable-term.json",
        "/schemas/core/applied-seller-adjustment.json",
        "/schemas/core/allowance-applied-webhook.json",
      ]) {
        const schema = readSchema(uri);
        assert.equal(schema["x-status"], "experimental", uri);
        assert.equal(schema["x-added-in"], "3.3.0", uri);
      }
      const doc = fs.readFileSync(
        path.join(__dirname, "..", "docs", "reference", "experimental-status.mdx"),
        "utf8"
      );
      assert.match(doc, /\| `media_buy\.seller_adjustment_allowances` \|/);
    });

    it("documents the generic mechanism, its worked examples, and what is out of scope", () => {
      const text = fs.readFileSync(
        path.join(__dirname, "..", "docs", "media-buy", "product-discovery", "proposal-negotiation.mdx"),
        "utf8"
      );
      const section = text.slice(
        text.indexOf("## Seller adjustment allowances"),
        text.indexOf("## Seller implementation")
      );
      for (const marker of [
        "seller_adjustable_terms[]",
        "Worked example: budget release",
        "Worked example: schedule shift and line alternates",
        "delivered-to-date plus in-flight",
        "$0 make-good package",
        "seller_system",
      ]) {
        assert.ok(section.includes(marker), marker);
      }
      assert.ok(!/`(budget_release|schedule_shift)` \|/.test(section));
    });
  });
});
