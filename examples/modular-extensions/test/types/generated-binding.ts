// Type-level test of the generated binding: what an app's own layer types. `npm run typecheck` must
// pass, and every @ts-expect-error line must stay an error. The layers are the examples' and the
// superset test app's (test/apps/superset), as `npm run sdk` writes them.
import type { Client as BuyerClient, CommercialTerms as BuyerTerms, MediaBuy as BuyerMediaBuy, Proposal as BuyerProposal } from '../../examples/buyer-app/adcp-sdk/index.ts';
import type { CommercialTerms as AgentTerms, MakegoodRule, Server as AgentServer } from '../../examples/sales-agent/adcp-sdk/index.ts';
import type { CommercialTerms, IndexedCPP, PricingOption, SellerAdjustableTerms, SellerAdjustableTermsV1_0_0 } from '../apps/superset/adcp-sdk/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T => true as T;

// Extension data is a plain attribute at its extension point, typed from the extension's schema.
declare const proposal: BuyerProposal;
const maxUnits = proposal.commercial_terms.makegood_units?.rules[0].max_units;
expect<Equal<typeof maxUnits, number | undefined>>();
const slip = proposal.commercial_terms.seller_adjustable_terms?.allowances[0].constraint;
if (slip?.kind === 'time_shift') expect<Equal<typeof slip.max_shift.unit, 'seconds' | 'minutes' | 'hours' | 'days' | 'campaign'>>();
// @ts-expect-error a misspelled attribute is an error, not an untyped key
proposal.commercial_terms.makegood_unitz;
// @ts-expect-error a misspelled field inside the extension data is an error too
proposal.commercial_terms.makegood_units?.rules[0].max_unitz;
// @ts-expect-error the wire container is not part of the app's type
proposal.commercial_terms.extensions;

// The readback on a media buy is a plain attribute too.
declare const mb: BuyerMediaBuy;
const issued = mb.makegood_units?.issued[0].package_id;
expect<Equal<typeof issued, string | undefined>>();

// The seller writes the attribute; a wrong value is a type error.
const rule: MakegoodRule = { rule_id: 'mg_video_1', purchase_index: 0, trigger: 'deliverable_missed', max_units: 1, window: { interval: 30, unit: 'days' }, keep_same: ['creator', 'platform'], at_no_cost: true };
declare const terms: AgentTerms;
terms.makegood_units = { rules: [rule] };
// @ts-expect-error max_units is a number
terms.makegood_units = { rules: [{ ...rule, max_units: '1' }] };
// @ts-expect-error the agent's layer has no seller-adjustable-terms: dropping an extension from the config breaks every use
terms.seller_adjustable_terms;
const buyerTerms: BuyerTerms = proposal.commercial_terms;

// A contributed task is a typed client method and a typed seller handler.
declare const client: BuyerClient;
const answer = client.requestMakegood({ idempotency_key: 'k-00000001', media_buy_id: 'mb_1', rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed' });
// @ts-expect-error a request must match MakegoodRequest: package_id is required
client.requestMakegood({ idempotency_key: 'k-00000002', media_buy_id: 'mb_1', rule_id: 'mg_video_2', reason: 'deliverable_missed' });
declare const server: AgentServer;
server.handle('request_makegood', (req) => ({ status: 'completed', outcome: 'rejected', rule_id: req.rule_id, rejection: { code: 'CAP_EXCEEDED', message: 'cap used' } }));
// @ts-expect-error a handler must answer with the response definition's type: 'refused' is not an outcome
server.handle('request_makegood', (req) => ({ status: 'completed', outcome: 'refused', rule_id: req.rule_id }));
// @ts-expect-error the agent's extensions contribute no such task
server.handle('request_makegood_twice', () => ({}));
server.handle('request_proposals', (req, ctx) => {
  // @ts-expect-error ctx.understands() takes an attribute of this layer
  ctx.understands('seller_adjustable_terms');
  return { outcome: 'proposed', proposals: [] };
});

// The pricing_model branch is a member of the pricing union: narrowing on the branch id gives its data.
declare const option: PricingOption;
if (option.pricing_model === 'https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp#indexed_cpp') {
  expect<Equal<typeof option.linear_tv_indexed_cpp, IndexedCPP>>();
  // @ts-expect-error an indexed-CPP option carries no core fixed price
  option.fixed_price;
} else {
  expect<Equal<typeof option.fixed_price, number | undefined>>();
  // @ts-expect-error a core option has no indexed-CPP data
  option.linear_tv_indexed_cpp;
}

// Two versions of one uri: two attributes, with their own types.
declare const both: CommercialTerms;
expect<Equal<typeof both.seller_adjustable_terms, SellerAdjustableTerms | undefined>>();
expect<Equal<typeof both.seller_adjustable_terms_v1_0, SellerAdjustableTermsV1_0_0 | undefined>>();

export { answer, buyerTerms };
