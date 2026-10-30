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
  let validateListed;

  before(async () => {
    [validateProposal, validateWebhook, validateMediaBuys, validateListed] = await Promise.all([
      compile(readSchema("/schemas/core/canonical-proposal.json")),
      compile(readSchema("/schemas/core/proposal-offered-webhook.json")),
      compile(readSchema("/schemas/media-buy/get-media-buys-response.json")),
      compile(readSchema("/schemas/media-buy/list-proposals-response.json")),
    ]);
  });

  describe("canonical-proposal.json", () => {
    it("accepts a committed seller update offer", () => {
      assert.ok(validateProposal(offer()), JSON.stringify(validateProposal.errors));
    });

    it("accepts a committed seller cancellation offer", () => {
      const cancellation = offer({
        proposal_kind: "media_buy_cancellation",
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
      assert.ok(validateProposal(buyer), JSON.stringify(validateProposal.errors));
    });

    it("keeps the reason for an offer out of the canonical terms", () => {
      const proposal = readSchema("/schemas/core/canonical-proposal.json");
      assert.equal(proposal.properties.offer_reason, undefined);
      assert.ok(!JSON.stringify(proposal.allOf).includes("offer_reason"));
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

    describe("list_proposals rows", () => {
      const row = (extra = {}, proposal = {}) => ({
        proposal: offer(proposal),
        disposition: "available",
        disposition_changed_at: "2026-10-20T14:01:00Z",
        origin: "seller_offer",
        offer_reason: "installment_postponed",
        ...extra,
      });
      const listed = (entry) => ({ status: "completed", outcome: "listed", proposals: [entry], opportunities: [] });

      it("carries offer_reason on a seller_offer row", () => {
        assert.ok(validateListed(listed(row())), JSON.stringify(validateListed.errors));
        assert.ok(
          validateListed(
            listed(row({ disposition: "accepted" }, { proposal_status: "accepted", accepted_at: "2026-10-21T09:00:00Z" }))
          ),
          JSON.stringify(validateListed.errors)
        );
      });

      it("requires offer_reason exactly when origin is seller_offer", () => {
        const missing = row();
        delete missing.offer_reason;
        assert.equal(validateListed(listed(missing)), false);
        assert.equal(validateListed(listed(row({ offer_reason: "invented" }))), false);
        const buyerRow = row({ origin: "request" }, { proposal_initiator: "buyer" });
        assert.equal(validateListed(listed(buyerRow)), false, "offer_reason is only for seller_offer rows");
        delete buyerRow.offer_reason;
        assert.ok(validateListed(listed(buyerRow)), JSON.stringify(validateListed.errors));
      });

      it("keeps offer_reason experimental and out of the proposal", () => {
        const schema = readSchema("/schemas/media-buy/list-proposals-response.json");
        const field = schema.properties.proposals.items.properties.offer_reason;
        assert.equal(field["x-status"], "experimental");
        assert.equal(field["x-added-in"], "3.3.0");
        assert.equal(field.$ref, "/schemas/enums/offer-reason.json");
      });
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
    });

    it("closes proposal_initiator to buyer and seller", () => {
      const initiators = readSchema("/schemas/enums/proposal-initiator.json");
      assert.deepEqual(initiators.enum, ["buyer", "seller"]);
      assert.deepEqual(Object.keys(initiators.enumDescriptions), initiators.enum);
    });

    it("marks the new surface experimental and added in 3.3.0", () => {
      const proposal = readSchema("/schemas/core/canonical-proposal.json");
      assert.equal(proposal.properties.proposal_initiator["x-status"], "experimental");
      assert.equal(proposal.properties.proposal_initiator["x-added-in"], "3.3.0");
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


  describe("seller-held change terms are planned for 4.0, not 3.3", () => {
    const docText = (...parts) =>
      fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

    it("adds nothing to commercial terms or change terms in 3.3", () => {
      const changeTerm = readSchema("/schemas/media-buy/change-term.json");
      for (const field of ["holder", "purchase_index"]) {
        assert.equal(changeTerm.properties[field], undefined, field);
      }
      const terms = readSchema("/schemas/media-buy/commercial-terms.json");
      assert.equal(terms.properties.seller_adjustable_terms, undefined);
      const kinds = readSchema("/schemas/media-buy/change-term-constraints.json").oneOf.map(
        (branch) => branch.properties.kind.const
      );
      assert.deepEqual(kinds, ["budget", "flight", "package_count", "effective_timing"]);
      for (const removed of [
        ["core", "seller-adjustable-term.json"],
        ["core", "applied-seller-adjustment.json"],
        ["core", "allowance-applied-webhook.json"],
        ["enums", "adjustment-direction.json"],
      ]) {
        assert.ok(!fs.existsSync(path.join(SCHEMA_ROOT, ...removed)), removed.join("/"));
      }
      const notifications = readSchema("/schemas/enums/notification-type.json");
      assert.ok(!notifications.enum.includes("media_buy.allowance_applied"));
      const offerReasons = readSchema("/schemas/enums/offer-reason.json").enum;
      assert.ok(!offerReasons.includes("term_applied"));
    });

    it("records the design in the 4.0 registry and the proposal-negotiation guide", () => {
      const registry = docText("static", "compliance", "source", "universal", "v4-compatibility.yaml");
      assert.match(registry, /id: seller_held_change_terms_required_in_4_0\n\s+issue: 8087\n\s+change: new_requirement/);
      const guide = docText("docs", "reference", "migration", "v4-compatibility.mdx");
      assert.match(guide, /<a id="seller_held_change_terms_required_in_4_0"><\/a>/);
      const negotiation = docText("docs", "media-buy", "product-discovery", "proposal-negotiation.mdx");
      const section = negotiation.slice(
        negotiation.indexOf("## Planned for 4.0: seller-held change terms"),
        negotiation.indexOf("## Seller implementation")
      );
      for (const marker of [
        "Not in 3.3",
        "`holder`",
        "`purchase_index`",
        "A seller MUST NOT lengthen a purchase whose `pricing_model` is `time`, or shorten one whose `pricing_model` is `flat_rate`",
        "Decreasing a purchase `budget` decreases `total_budget`, when present, by the same amount",
        "binds them through `accept_proposal`",
        "mints an accepted successor proposal",
      ]) {
        assert.ok(section.includes(marker), marker);
      }
      assert.ok(!negotiation.includes("seller_adjustable_terms"));
      assert.ok(!/media_buy\.seller_adjustment_allowances/.test(docText("docs", "reference", "experimental-status.mdx")));
    });
  });
});
