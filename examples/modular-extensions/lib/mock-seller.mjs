// CreatorHub, a creator network's sales agent, for the creator scenario. It runs in process:
// the buyer SDK calls transport.call(name, request) and receives JSON exactly as it would over
// MCP or A2A.
//
// The flow is proposal-based: request_proposals -> refine_proposals (finalize) ->
// accept_proposal -> get_media_buys. request_proposals returns canonical proposals with
// commercial_terms and terms_digest, plus the compact products they buy. This seller has
// no get_products: discovery-time pricing options are not part of this scenario.
//
// The agent is written the way a sales agent uses the SDK:
//  - lib/server.mjs does the protocol work: it validates every request and response against
//    the frozen core (or, for a contributed task, against the extension's definitions), answers
//    get_adcp_capabilities from what the agent declares and handles, and tells each handler
//    which extension versions the caller understands (ctx.agreed);
//  - the generated extension modules write the extension data: commercialTermsEntry(),
//    mediaBuyStateEntry(), and the typed task descriptor makegoodUnits.tasks.requestMakegood;
//  - it serves two versions of seller-adjustable-terms side by side: 1.0.0 (allowances, no
//    readback) for buyers pinned to it, and the current version;
//  - its back office (ops.*) changes the live buy within the accepted terms, writes extension
//    readback, and emits a core account.change_recorded record. The buyer can also ask for a
//    make-good itself, through the task the makegood-units extension contributes.
import { termsDigest } from './digest.mjs';
import { SellerRejection, createAdcpServer, fromRegistry } from './server.mjs';
import * as makegoodUnits from '../packages/ext-makegood-units/src/index.mjs';
import * as sellerAdjustableTerms from '../packages/ext-seller-adjustable-terms/src/index.mjs';

export { SellerRejection };

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** The buying layers the creator network implements: it negotiates proposals (buying/offer) and doesn't sell from catalogs. */
export const CREATOR_NETWORK_MODULES = ['buying/targeting', 'buying/pricing', 'buying/commitment', 'buying/supply', 'buying/offer', 'buying/execution'];

/**
 * @param options.ignoreUnderstood a misbehaving seller (conformance fixtures): it ignores the
 *   buyer's understood_extensions and sends the newest version of every extension it supports.
 * @param options.modules the modules and buying layers it lists, with their versions and digests, in
 *   its capabilities (`modules`).
 */
export function createCreatorNetworkSeller({ now = () => Date.parse('2027-03-01T09:00:00Z'), ignoreUnderstood = false, modules = CREATOR_NETWORK_MODULES } = {}) {
  const server = createAdcpServer({ protocols: ['media_buy'], ignoreUnderstood, modules });

  // ---- the extensions this agent emits, pinned by digest ----
  server.declare(fromRegistry(sellerAdjustableTerms.EXTENSION_URI, '1.0.0')); // buyers pinned to 1.0.0
  server.declare(sellerAdjustableTerms);
  server.declare(makegoodUnits);

  const proposals = new Map();
  const mediaBuys = new Map();
  let seq = 0;
  const nextId = (p) => `${p}_${++seq}`;

  // ---- the offer: two sponsored YouTube integrations with one creator ----
  const PRODUCT = {
    product_id: 'maya_cooks_youtube_integration',
    name: 'Maya Cooks: sponsored YouTube integration',
    channels: ['influencer'],
    delivery_type: 'guaranteed',
    pricing_options: [{ pricing_option_id: 'po_flat_integration', pricing_model: 'flat_rate', currency: 'EUR', fixed_price: 12000 }],
  };
  const purchase = (i, start) => ({
    product_id: 'maya_cooks_youtube_integration',
    pricing_option_id: 'po_flat_integration',
    pricing: { pricing_option_id: 'po_flat_integration', pricing_model: 'flat_rate', currency: 'EUR', fixed_price: 12000 },
    budget: 12000,
    start_time: start,
    end_time: iso(Date.parse(start) + 7 * DAY),
    context: { deliverable: `video ${i + 1}` },
  });

  /** One free replacement per video within 30 days, same creator and platform. */
  const makegoodRule = (i) => ({
    rule_id: `mg_video_${i + 1}`,
    purchase_index: i,
    trigger: 'deliverable_missed',
    max_units: 1,
    window: { interval: 30, unit: 'days' },
    keep_same: ['creator', 'platform'],
    at_no_cost: true,
  });

  /** Each video may slip up to 7 days, with 48 hours' notice. */
  const slip = (i, field) => ({
    allowance_id: `slip_v${i + 1}_${field === '/start_time' ? 'start' : 'end'}`,
    purchase_index: i,
    path: field,
    constraint: { kind: 'time_shift', direction: 'later', max_shift: { interval: 7, unit: 'days' } },
    min_notice: { interval: 48, unit: 'hours' },
  });

  /** The commercial terms for this buyer: extension data only at the versions it understands. */
  function commercialTermsFor(ctx) {
    const purchases = [purchase(0, '2027-03-10T17:00:00Z'), purchase(1, '2027-03-24T17:00:00Z')];
    const extensions = []; // ordered by uri: makegood-units, then seller-adjustable-terms
    if (ctx.agreed(makegoodUnits.EXTENSION_URI)) {
      extensions.push(makegoodUnits.commercialTermsEntry({ rules: [makegoodRule(0), makegoodRule(1)] }));
    }
    const sat = ctx.agreed(sellerAdjustableTerms.EXTENSION_URI);
    if (sat) {
      const allowances = { allowances: [slip(0, '/end_time'), slip(0, '/start_time'), slip(1, '/end_time'), slip(1, '/start_time')] };
      // The current version has a generated writer; the older pinned version gets the plain envelope.
      extensions.push(sat.digest === sellerAdjustableTerms.EXTENSION_DIGEST ? sellerAdjustableTerms.commercialTermsEntry(allowances) : server.entry(sat, allowances));
    }
    return {
      brand: { domain: 'brand.example.com' },
      purchases,
      start_time: purchases[0].start_time,
      end_time: purchases[1].end_time,
      total_budget: { amount: 24000, currency: 'EUR' },
      ...(extensions.length ? { extensions } : {}),
    };
  }

  function snapshot(fields) {
    const p = { ...fields, terms_digest: termsDigest(fields.commercial_terms) };
    server.assertCore('/schemas/core/canonical-proposal.json', p, 'proposal', 'INVALID_RESPONSE');
    proposals.set(p.proposal_id, p);
    return structuredClone(p);
  }

  // ---- kernel and module tasks ----
  server.handle('request_proposals', (req, ctx) => {
    const draft = snapshot({
      proposal_id: nextId('prop'),
      proposal_kind: 'new_media_buy',
      proposal_status: 'draft',
      expires_at: iso(now() + 2 * DAY),
      name: 'Maya Cooks: two sponsored integrations, March',
      commercial_terms: commercialTermsFor(ctx),
    });
    return { status: 'completed', outcome: 'proposed', proposals: [draft], products: [PRODUCT] };
  });

  server.handle('refine_proposals', (req, ctx) => ({
    proposals: req.refinements.map((r) => {
      const src = proposals.get(r.proposal_id);
      if (!src || src.proposal_status !== 'draft' || r.action !== 'finalize') throw new SellerRejection('INVALID_REQUEST', 'only finalize of a draft is modelled');
      const placed = now();
      const { terms_digest, ...rest } = src;
      return snapshot({
        ...rest,
        proposal_id: nextId('prop'),
        proposal_status: 'committed',
        hold_policy: { available: true, min_duration: 'P2D', max_duration: 'P3D' },
        hold_placed_at: iso(placed),
        expires_at: iso(placed + 3 * DAY),
        commercial_terms: commercialTermsFor(ctx),
      });
    }),
  }));

  server.handle('accept_proposal', (req) => {
    const p = proposals.get(req.proposal_id);
    if (!p || p.proposal_status !== 'committed') throw new SellerRejection('PROPOSAL_NOT_COMMITTED', req.proposal_id);
    if (p.terms_digest !== req.proposal_terms_digest) throw new SellerRejection('TERMS_DIGEST_MISMATCH', req.proposal_id);
    const media_buy_id = nextId('mb');
    const ct = p.commercial_terms;
    const accepted = { ...structuredClone(p), proposal_status: 'accepted', accepted_at: iso(now()), media_buy_id };
    delete accepted.hold_policy;
    delete accepted.hold_placed_at;
    mediaBuys.set(media_buy_id, {
      media_buy_id,
      name: req.name ?? p.name,
      accepted_proposal_id: p.proposal_id,
      accepted_proposal_terms_digest: p.terms_digest,
      accepted_proposal: accepted,
      status: 'pending_start',
      currency: 'EUR',
      total_budget: ct.total_budget.amount,
      start_time: ct.start_time,
      end_time: ct.end_time,
      confirmed_at: iso(now()),
      revision: 1,
      available_actions: [],
      packages: ct.purchases.map((pu, i) => ({
        package_id: `pkg_video_${i + 1}`,
        product_id: pu.product_id,
        budget: pu.budget,
        start_time: pu.start_time,
        end_time: pu.end_time,
      })),
    });
    return { media_buy_id, revision: 1, accepted_proposal_id: p.proposal_id };
  });

  server.handle('get_media_buys', (req) => ({
    status: 'completed',
    media_buys: (req.media_buy_ids ?? [...mediaBuys.keys()]).map((id) => structuredClone(mediaBuys.get(id))),
  }));

  // ---- the task makegood-units contributes: the buyer asks for a unit under an accepted rule ----
  const answered = new Map(); // idempotency_key -> first response
  server.handle(
    makegoodUnits.tasks.requestMakegood,
    (req) => {
      if (answered.has(req.idempotency_key)) return answered.get(req.idempotency_key);
      const mb = mediaBuys.get(req.media_buy_id);
      if (!mb) throw new SellerRejection('MEDIA_BUY_NOT_FOUND', req.media_buy_id);
      const rejected = (code, message) => ({ status: 'completed', outcome: 'rejected', rule_id: req.rule_id, rejection: { code, message } });
      const rule = makegoodUnits.readCommercialTerms(mb.accepted_proposal.commercial_terms)?.rules.find((r) => r.rule_id === req.rule_id);
      const issued = makegoodUnits.readMediaBuyState(mb)?.issued.filter((u) => u.rule_id === req.rule_id).length ?? 0;
      let res;
      if (!rule) res = rejected('RULE_NOT_ACCEPTED', `rule ${req.rule_id} is not in the accepted terms of ${mb.media_buy_id}`);
      else if (mb.packages[rule.purchase_index].package_id !== req.package_id || rule.trigger !== req.reason) {
        res = rejected('RULE_NOT_ACCEPTED', `rule ${rule.rule_id} covers ${rule.trigger} on ${mb.packages[rule.purchase_index].package_id}`);
      } else if (issued >= rule.max_units) res = rejected('CAP_EXCEEDED', `rule ${rule.rule_id} allows ${rule.max_units} unit(s); ${issued} already issued`);
      else {
        const { unit } = issueMakegood(mb, rule);
        res = { status: 'completed', outcome: 'accepted', rule_id: rule.rule_id, makegood_id: unit.makegood_id, package_id: unit.package_id, revision: unit.revision, change_id: unit.change_id };
      }
      answered.set(req.idempotency_key, res);
      return res;
    },
    { name: 'x_request_makegood' }
  );

  // ---- seller back office: changes inside the accepted terms ----

  /** Add readback to the media buy: append to this extension's entry, or add the entry in uri order. */
  function addReadback(mb, entry, list) {
    mb.extensions_state ??= [];
    const existing = mb.extensions_state.find((x) => x.uri === entry.uri);
    if (existing) existing.data[list].push(...entry.data[list]);
    else {
      mb.extensions_state.push(entry);
      mb.extensions_state.sort((a, b) => (a.uri < b.uri ? -1 : 1));
    }
  }

  function record(mb, changed_paths, reason, summary) {
    mb.revision += 1;
    return server.publish({
      change_id: nextId('chg'),
      recorded_at: iso(now()),
      resource: { type: 'media_buy', account_id: 'acc_brand_example', resource_id: mb.media_buy_id },
      action: 'updated',
      origin: { kind: 'seller_system' },
      resource_revision: mb.revision,
      changed_paths,
      repair: { task: 'get_media_buys' },
      reason,
      summary,
    });
  }

  /** Move one deliverable later, inside the accepted allowance. Start and end move in one revision. */
  function shift(mediaBuyId, i, days, reason) {
    const mb = mediaBuys.get(mediaBuyId);
    if (!sellerAdjustableTerms.readCommercialTerms(mb.accepted_proposal.commercial_terms)) {
      throw new SellerRejection('NO_ALLOWANCE', `this buyer did not accept seller-adjustable-terms ${sellerAdjustableTerms.EXTENSION_VERSION}; make an offer instead`);
    }
    const pkg = mb.packages[i];
    const applied_at = iso(now());
    const changes = [
      ['start', '/start_time', 'start_time'],
      ['end', '/end_time', 'end_time'],
    ].map(([suffix, pathName, field]) => {
      const previous_value = pkg[field];
      pkg[field] = iso(Date.parse(previous_value) + days * DAY);
      return { allowance_id: `slip_v${i + 1}_${suffix}`, path: pathName, previous_value, value: pkg[field] };
    });
    mb.end_time = mb.packages.map((p) => p.end_time).sort().at(-1);
    const change = record(mb, [`/packages/${i}/start_time`, `/packages/${i}/end_time`, '/end_time'], reason, `video ${i + 1} moved ${days} days later`);
    const applied = changes.map((c) => ({
      adjustment_id: nextId('adj'),
      allowance_id: c.allowance_id,
      revision: mb.revision,
      change_id: change.change_id,
      applied_at,
      reason,
      purchase_index: i,
      path: c.path,
      previous_value: c.previous_value,
      value: c.value,
    }));
    addReadback(mb, sellerAdjustableTerms.mediaBuyStateEntry({ applied }), 'applied');
    return change;
  }

  /** Replace a missed deliverable under its rule: cancel it, add a zero-cost unit, write the ledger, announce it. */
  function issueMakegood(mb, rule) {
    const missed = mb.packages[rule.purchase_index];
    missed.canceled = true;
    missed.cancellation = { canceled_at: iso(now()), canceled_by: 'seller', reason: 'creator could not produce the video' };
    const package_id = `pkg_makegood_${rule.purchase_index + 1}`;
    const start = iso(Date.parse(missed.end_time) + 7 * DAY);
    mb.packages.push({ package_id, product_id: missed.product_id, budget: 0, start_time: start, end_time: iso(Date.parse(start) + 7 * DAY) });
    mb.end_time = mb.packages.map((p) => p.end_time).sort().at(-1);
    const change = record(mb, [`/packages/${rule.purchase_index}/canceled`, `/packages/${mb.packages.length - 1}`, '/end_time'], rule.trigger, `video ${rule.purchase_index + 1} replaced by a zero-cost make-good`);
    const unit = {
      makegood_id: nextId('mg'),
      rule_id: rule.rule_id,
      revision: mb.revision,
      change_id: change.change_id,
      issued_at: iso(now()),
      reason: rule.trigger,
      package_id,
      evidence: { creator: { original: '@maya.cooks', makegood: '@maya.cooks' }, platform: { original: 'youtube', makegood: 'youtube' } },
    };
    addReadback(mb, makegoodUnits.mediaBuyStateEntry({ issued: [unit] }), 'issued');
    return { unit, change };
  }

  const ops = {
    /** The creator is ill: move the video within the pre-agreed window. */
    creatorUnavailable: (mediaBuyId, i, days) => shift(mediaBuyId, i, days, 'creator_unavailable'),
    /** Same, but past the agreed 7 days. The seller should have made an offer; the buyer SDK will flag it. */
    rogueShift: (mediaBuyId, i, days) => shift(mediaBuyId, i, days, 'creator_unavailable'),

    /** A deliverable cannot be produced at all: the seller issues the make-good itself, under the video's rule. */
    deliverableMissed(mediaBuyId, i) {
      const mb = mediaBuys.get(mediaBuyId);
      const rule = makegoodUnits.readCommercialTerms(mb.accepted_proposal.commercial_terms)?.rules.find((r) => r.purchase_index === i);
      if (!rule) throw new SellerRejection('NO_MAKEGOOD_RULE', 'this buyer did not accept make-good units; make an offer instead');
      return issueMakegood(mb, rule).change;
    },
  };

  const supported = server.declared.map(({ uri, version, digest }) => ({ uri, version, digest }));
  return { transport: server.transport, ops, supported, server };
}
