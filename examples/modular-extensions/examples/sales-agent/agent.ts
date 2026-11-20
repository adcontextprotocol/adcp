// A sales agent (seller) that sells two sponsored creator videos with pre-agreed make-good
// rules, and serves the request_makegood task that the makegood-units extension contributes.
// It uses core 3.3 + one extension, chosen in adcp.config.json.
//
//   npm run sdk      # adcp.config.json -> adcp.lock.json + adcp-sdk/ (this agent's typed layer)
//   npm run agent    # node --experimental-strip-types examples/sales-agent/agent.ts
//
// The generated layer gives the agent its own types: the make-good rules are a plain attribute,
// terms.makegood_units, and the readback ledger is mediaBuy.makegood_units. createServer() declares
// the extension, encodes each response to the wire (commercial_terms.extensions[],
// extensions_state[]) and validates it, and answers get_adcp_capabilities. At the end, a buyer
// built on the same layer drives the agent and the file prints what happens.
import { SellerRejection } from '../../lib/server.mjs';
import { createClient, createServer, type CommercialTerms, type MakegoodRule, type MediaBuy, type Proposal } from './adcp-sdk/index.ts';

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const DAY = 864e5;

type Buy = MediaBuy & {
  currency: string;
  confirmed_at: string;
  available_actions: string[];
  accepted_proposal_id: string;
  accepted_proposal_terms_digest: string;
  accepted_proposal: Proposal;
  packages: { package_id: string; budget: number; start_time: string; end_time: string; canceled?: boolean }[];
};

export function createSalesAgent() {
  // Declares makegood-units: capabilities list it with its hooks, and the task once it is handled.
  const server = createServer({ protocols: ['media_buy'] });

  const proposals = new Map<string, Proposal>();
  const buys = new Map<string, Buy>();
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;

  const product = { product_id: 'creator_video', name: 'Sponsored creator video', pricing_options: [{ pricing_option_id: 'po_flat', pricing_model: 'flat_rate' as const, currency: 'EUR', fixed_price: 12000 }] };
  const video = (i: number) => ({
    product_id: product.product_id,
    pricing_option_id: 'po_flat',
    pricing: { pricing_option_id: 'po_flat', pricing_model: 'flat_rate' as const, currency: 'EUR', fixed_price: 12000 },
    budget: 12000,
    start_time: iso(Date.parse('2027-03-10T17:00:00Z') + i * 14 * DAY),
    end_time: iso(Date.parse('2027-03-17T17:00:00Z') + i * 14 * DAY),
  });
  // One free replacement per video within 30 days, same creator and platform.
  const rule = (i: number): MakegoodRule => ({
    rule_id: `mg_video_${i + 1}`,
    purchase_index: i,
    trigger: 'deliverable_missed',
    max_units: 1,
    window: { interval: 30, unit: 'days' },
    keep_same: ['creator', 'platform'],
    at_no_cost: true,
  });

  function proposal(status: 'draft' | 'committed', makegoods: boolean): Proposal {
    const [first, second] = [video(0), video(1)];
    const terms: CommercialTerms = { brand: { domain: 'brand.example.com' }, purchases: [first, second], start_time: first.start_time, end_time: second.end_time };
    // A plain attribute; the layer writes the envelope { uri, digest, data } for this exact digest.
    if (makegoods) terms.makegood_units = { rules: [rule(0), rule(1)] };
    const p: Proposal = { proposal_id: id('prop'), proposal_kind: 'new_media_buy', proposal_status: status, name: 'Two sponsored videos', expires_at: iso(Date.now() + 2 * DAY), commercial_terms: terms, terms_digest: server.termsDigest(terms) };
    proposals.set(p.proposal_id, p);
    return p;
  }

  // Kernel and module tasks: the rules go only to a buyer that listed the extension.
  server.handle('request_proposals', (req, ctx) => ({ status: 'completed', outcome: 'proposed', proposals: [proposal('draft', ctx.understands('makegood_units'))], products: [product] }));
  server.handle('refine_proposals', (req, ctx) => ({ proposals: [proposal('committed', ctx.understands('makegood_units'))] }));
  server.handle('accept_proposal', (req) => {
    const p = proposals.get(req.proposal_id);
    if (!p || p.terms_digest !== req.proposal_terms_digest) throw new SellerRejection('TERMS_DIGEST_MISMATCH', req.proposal_id);
    const media_buy_id = id('mb');
    const packages = p.commercial_terms.purchases.map((pu, i) => ({ package_id: `pkg_video_${i + 1}`, budget: pu.budget ?? 0, start_time: pu.start_time!, end_time: pu.end_time! }));
    const accepted: Proposal = { ...p, proposal_status: 'accepted', accepted_at: iso(Date.now()), media_buy_id };
    buys.set(media_buy_id, {
      media_buy_id, status: 'pending_start', currency: 'EUR', confirmed_at: iso(Date.now()), revision: 1, total_budget: 24000, available_actions: [],
      accepted_proposal_id: p.proposal_id, accepted_proposal_terms_digest: p.terms_digest, accepted_proposal: accepted, packages,
    });
    return { media_buy_id, revision: 1, accepted_proposal_id: p.proposal_id };
  });
  server.handle('get_media_buys', (req) => ({ status: 'completed', media_buys: req.media_buy_ids.flatMap((b) => buys.get(b) ?? []) }));

  // The contributed task: request and response types come from the extension's schema.
  server.handle('request_makegood', (req) => {
    const buy = buys.get(req.media_buy_id);
    if (!buy) throw new SellerRejection('MEDIA_BUY_NOT_FOUND', req.media_buy_id);
    const rule = buy.accepted_proposal.commercial_terms.makegood_units?.rules.find((r) => r.rule_id === req.rule_id);
    const ledger = buy.makegood_units; // this extension's readback ledger, a plain attribute
    const issued = ledger?.issued ?? [];
    if (!rule || buy.packages[rule.purchase_index].package_id !== req.package_id) {
      return { status: 'completed', outcome: 'rejected', rule_id: req.rule_id, rejection: { code: 'RULE_NOT_ACCEPTED', message: `no accepted rule ${req.rule_id} for ${req.package_id}` } };
    }
    if (issued.filter((u) => u.rule_id === rule.rule_id).length >= rule.max_units) {
      return { status: 'completed', outcome: 'rejected', rule_id: rule.rule_id, rejection: { code: 'CAP_EXCEEDED', message: `max_units ${rule.max_units} used` } };
    }
    // Cancel the missed video, add a zero-cost package, and record the unit in the readback ledger.
    const missed = buy.packages[rule.purchase_index];
    missed.canceled = true;
    const start = iso(Date.parse(missed.end_time) + 7 * DAY);
    const unit = { makegood_id: id('mg'), rule_id: rule.rule_id, revision: ++buy.revision, change_id: id('chg'), issued_at: iso(Date.now()), reason: rule.trigger, package_id: `pkg_makegood_${rule.purchase_index + 1}`, evidence: { creator: { original: '@maya.cooks', makegood: '@maya.cooks' }, platform: { original: 'youtube', makegood: 'youtube' } } };
    buy.packages.push({ package_id: unit.package_id, budget: 0, start_time: start, end_time: iso(Date.parse(start) + 7 * DAY) });
    if (ledger) ledger.issued.push(unit);
    else buy.makegood_units = { issued: [unit] };
    return { status: 'completed', outcome: 'accepted', rule_id: rule.rule_id, makegood_id: unit.makegood_id, package_id: unit.package_id, revision: unit.revision, change_id: unit.change_id };
  });

  return server;
}

// A buyer built on the same layer buys the videos and asks for a make-good.
{
  const agent = createSalesAgent();
  const buyer = await createClient({ transport: agent.transport });
  const caps = await buyer.capabilities();
  console.log('declared:', JSON.stringify(caps.declared_extensions?.[0].tasks));
  const { proposals: [draft] = [] } = await buyer.requestProposals({ idempotency_key: 'agent-request-0001', brief: 'Two sponsored videos', brand: { domain: 'brand.example.com' } });
  const { proposals: [committed] } = await buyer.refineProposals({ idempotency_key: 'agent-finalize-0001', refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
  const { media_buy_id } = await buyer.acceptProposal({ proposal: committed, idempotency_key: 'agent-accept-0001', account: { account_id: 'acc_1' } });
  const request = { media_buy_id, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed' } as const;
  for (const key of ['agent-makegood-0001', 'agent-makegood-0002']) {
    const answer = await buyer.requestMakegood({ ...request, idempotency_key: key });
    console.log(`${buyer.lastTaskCall?.name}:`, answer.outcome === 'accepted' ? `accepted, package ${answer.package_id}` : `rejected, ${answer.rejection.code}`);
  }
  await buyer.getMediaBuys({ media_buy_ids: [media_buy_id] });
  console.log('readback:', buyer.lastReport?.extensions.map((e) => `${e.point} ${e.status}`).join(', '), `violations ${buyer.lastReport?.violations.length}`);
}
