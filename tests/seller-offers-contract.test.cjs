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
      for (const marker of ["**anchor**", "**notification_id**", "**repair key**", "**classification**", "list_proposals", "identifiers only", "proposal.created"]) {
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

  describe("seller adjustment allowances (media_buy.seller_adjustment_allowances)", () => {
    let validateAllowance;
    let validateApplied;
    let validateAppliedWebhook;
    let validateTerms;

    const release = (extra = {}) => ({
      allowance_id: "allow_release_1",
      kind: "budget_release",
      purchase_index: 0,
      max_release_fraction: 0.2,
      min_notice: { interval: 7, unit: "days" },
      ...extra,
    });
    const shift = (extra = {}) => ({
      allowance_id: "allow_alt_1",
      kind: "schedule_shift",
      purchase_index: 0,
      max_shift: { interval: 2, unit: "days" },
      ...extra,
    });
    const applied = (extra = {}) => ({
      adjustment_id: "adj_mb_a_0003",
      allowance_id: "allow_release_1",
      kind: "budget_release",
      revision: 6,
      applied_at: "2026-11-12T09:30:00Z",
      reason: "Forecast delivery is 82% of the committed budget",
      released_amount: 400,
      ...extra,
    });

    before(async () => {
      [validateAllowance, validateApplied, validateAppliedWebhook, validateTerms] =
        await Promise.all([
          compile(readSchema("/schemas/core/seller-adjustment-allowance.json")),
          compile(readSchema("/schemas/core/applied-seller-adjustment.json")),
          compile(readSchema("/schemas/core/allowance-applied-webhook.json")),
          compile(readSchema("/schemas/media-buy/commercial-terms.json")),
        ]);
    });

    it("accepts a budget_release and the documented examples", () => {
      assert.ok(validateAllowance(release()), JSON.stringify(validateAllowance.errors));
      const schema = readSchema("/schemas/core/seller-adjustment-allowance.json");
      for (const example of schema.examples) {
        assert.ok(validateAllowance(example.data), JSON.stringify(validateAllowance.errors));
      }
    });

    it("keeps the two kinds closed and their bounds on the right kind", () => {
      const kinds = readSchema("/schemas/enums/seller-adjustment-kind.json");
      assert.deepEqual(kinds.enum, ["budget_release", "schedule_shift"]);
      assert.deepEqual(Object.keys(kinds.enumDescriptions), kinds.enum);
      assert.equal(validateAllowance(release({ kind: "price_change" })), false);
      assert.equal(validateAllowance(release({ max_shift: { interval: 1, unit: "days" } })), false);
      assert.equal(validateAllowance(shift({ max_release_fraction: 0.1 })), false);
    });

    it("bounds max_release_fraction to (0, 1]", () => {
      assert.ok(validateAllowance(release({ max_release_fraction: 1 })));
      assert.equal(validateAllowance(release({ max_release_fraction: 0 })), false);
      assert.equal(validateAllowance(release({ max_release_fraction: 1.5 })), false);
    });

    it("requires max_shift or alternates on a schedule_shift", () => {
      assert.ok(validateAllowance(shift()));
      const alt = { label: "Quiz Night", collection: { publisher_domain: "network.example", collection_id: "quiz_night" } };
      const onlyAlternates = shift({ alternates: [alt] });
      delete onlyAlternates.max_shift;
      assert.ok(validateAllowance(onlyAlternates), JSON.stringify(validateAllowance.errors));
      const neither = shift();
      delete neither.max_shift;
      assert.equal(validateAllowance(neither), false);
      assert.equal(validateAllowance(shift({ alternates: [{ label: "No reference" }] })), false);
    });

    it("requires allowance_id, kind and purchase_index", () => {
      for (const field of ["allowance_id", "kind", "purchase_index"]) {
        const bad = release();
        delete bad[field];
        assert.equal(validateAllowance(bad), false, field);
      }
    });

    it("rides commercial_terms and is covered by the terms digest", () => {
      assert.ok(
        validateTerms(terms({ seller_adjustment_allowances: [release(), shift({ allowance_id: "allow_2" })] })),
        JSON.stringify(validateTerms.errors)
      );
      assert.equal(validateTerms(terms({ seller_adjustment_allowances: [] })), false);
      const ct = readSchema("/schemas/media-buy/commercial-terms.json");
      const field = ct.properties.seller_adjustment_allowances;
      assert.equal(field["x-status"], "experimental");
      assert.equal(field["x-added-in"], "3.3.0");
      assert.equal(field["x-adcp-validation"].unique_by, "allowance_id");
      assert.equal(field["x-adcp-validation"].verifier_constraints.allowance_bounds.purchase_index, "less_than_purchases_length");
      assert.match(field.description, /pinned below AdCP 3\.3/);
    });

    it("validates an applied adjustment per kind", () => {
      assert.ok(validateApplied(applied()), JSON.stringify(validateApplied.errors));
      const shifted = applied({
        kind: "schedule_shift",
        allowance_id: "allow_alt_1",
        scheduled_at: "2026-11-20T01:00:00Z",
        previous_scheduled_at: "2026-11-19T01:00:00Z",
        alternate_index: 0,
      });
      delete shifted.released_amount;
      assert.ok(validateApplied(shifted), JSON.stringify(validateApplied.errors));
      const noAmount = applied();
      delete noAmount.released_amount;
      assert.equal(validateApplied(noAmount), false);
      assert.equal(validateApplied(applied({ released_amount: 0 })), false);
      assert.equal(validateApplied(applied({ scheduled_at: "2026-11-20T01:00:00Z" })), false);
    });

    it("keeps shift fields off a release and budget fields off a shift", () => {
      assert.equal(validateApplied(applied({ previous_scheduled_at: "2026-11-19T01:00:00Z" })), false);
      assert.ok(validateApplied(applied({ previous_budget: 5000, resulting_budget: 4600, cumulative_released: 400 })));
      const shifted = {
        adjustment_id: "adj_mb_a_0004",
        allowance_id: "allow_alt_1",
        kind: "schedule_shift",
        revision: 7,
        applied_at: "2026-11-13T09:30:00Z",
        reason: "Preempted by a live event",
        scheduled_at: "2026-11-20T01:00:00Z",
        alternate_index: 1,
        skipped_alternates: [{ alternate_index: 0, reason: "Preempted" }],
      };
      assert.ok(validateApplied(shifted), JSON.stringify(validateApplied.errors));
      assert.equal(validateApplied({ ...shifted, resulting_budget: 10 }), false);
    });

    it("keeps allowances off cancellation proposals", () => {
      const cancellation = offer({
        proposal_kind: "media_buy_cancellation",
        offer_reason: "seller_request",
        commercial_terms: terms({
          cancellation_terms: { effective_at: "2026-10-26T00:00:00Z" },
          seller_adjustment_allowances: [release()],
        }),
      });
      assert.equal(validateProposal(cancellation), false);
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
        change_origin: "seller_allowance",
        allowance_id: "allow_release_1",
        reason: "Forecast shortfall",
      };
      assert.ok(
        validateMediaBuys(response(buy({ applied_adjustments: [applied()] }, [entry]))),
        JSON.stringify(validateMediaBuys.errors)
      );
      const noReason = { ...entry };
      delete noReason.reason;
      assert.equal(validateMediaBuys(response(buy({}, [noReason]))), false);
      assert.equal(validateMediaBuys(response(buy({}, [{ ...entry, change_origin: "unilateral" }]))), false);
      const origins = readSchema("/schemas/enums/change-origin.json");
      assert.deepEqual(origins.enum, ["buyer", "seller_offer", "seller_allowance"]);
      assert.deepEqual(Object.keys(origins.enumDescriptions), origins.enum);
    });

    it("announces an applied adjustment through media_buy.allowance_applied", () => {
      const schema = readSchema("/schemas/core/allowance-applied-webhook.json");
      for (const example of schema.examples) {
        assert.ok(validateAppliedWebhook(example.data), JSON.stringify(validateAppliedWebhook.errors));
      }
      assert.equal(
        validateAppliedWebhook({ ...schema.examples[0].data, released_amount: 400 }),
        false
      );
      const type = readSchema("/schemas/enums/notification-type.json");
      assert.ok(type.enum.includes("media_buy.allowance_applied"));
      const description = type.enumDescriptions["media_buy.allowance_applied"];
      for (const marker of ["account-anchored", "notification_id", "get_media_buys", "invalidation-only"]) {
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
        "/schemas/enums/seller-adjustment-kind.json",
        "/schemas/enums/change-origin.json",
        "/schemas/core/seller-adjustment-allowance.json",
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
  });
});
