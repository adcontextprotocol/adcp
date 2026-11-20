// A buyer agent that buys two sponsored creator videos against a proposal, and
// copes with the creator getting ill: one video slips, and for the other the buyer
// asks for the make-good the terms allow, through the request_makegood task that the
// makegood-units extension contributes. It uses core 3.3 + two extensions, chosen in
// adcp.config.json.
//
//   npm run sdk        # adcp.config.json -> adcp.lock.json + adcp-sdk/ (this app's typed layer: the
//                      # extension data is a plain attribute; the core package is not rebuilt)
//   npm run app        # node --experimental-strip-types examples/buyer-app/app.ts
import { createCreatorNetworkSeller } from '../../lib/mock-seller.mjs';
import { createClient, type CommercialTerms } from './adcp-sdk/index.ts';

const log = (...a: unknown[]) => console.log(' ', ...a);
const step = (s: string) => console.log(`\n== ${s}`);

// In production this is the MCP/A2A transport to the seller agent.
const seller = createCreatorNetworkSeller();

// The client of this app's generated layer: it knows the two extensions adcp.config.json lists.
const client = await createClient({
  transport: seller.transport,
  onViolation: (v) => log(`DISPUTE ${v.message}`),
});

step('1. What the seller can do');
const caps = await client.capabilities();
log('usable extensions:', caps.negotiation.usable.map((k) => k.replace(/^https:\/\/[^/]+\//, '').replace(/@sha256:(.{8}).*/, '@$1…')));
for (const [task, { name }] of Object.entries(caps.negotiation.tasks)) log(`task ${task.replace(/^https:\/\/[^/]+\//, '')} -> transport name ${name}`);

step('2. Brief -> draft proposal via request_proposals (the SDK sends understood_extensions for us)');
// request_proposals returns canonical proposals: commercial_terms + terms_digest. (get_products
// proposals are legacy core/proposal.json plans with no commercial_terms.)
const { proposals = [] } = await client.requestProposals({
  idempotency_key: 'request-0001-aaaaaaaaa',
  brief: 'Two sponsored YouTube integrations with a cooking creator in March',
  brand: { domain: 'brand.example.com' },
});
const draft = proposals[0];

// Extension data is a plain attribute, typed from the extension's schema. It is set only when the
// terms carry exactly the digest this app was generated for.
const terms = draft.commercial_terms;
log(`proposal ${draft.proposal_id}: ${terms.purchases.length} videos, EUR ${terms.total_budget?.amount}`);
for (const a of terms.seller_adjustable_terms?.allowances ?? []) {
  if (a.constraint.kind === 'time_shift') log(`  allowance ${a.allowance_id}: ${a.path} may move ${a.constraint.direction} by <= ${a.constraint.max_shift.interval} ${a.constraint.max_shift.unit}`);
}
for (const r of terms.makegood_units?.rules ?? []) log(`  make-good ${r.rule_id}: <= ${r.max_units} free unit(s) within ${r.window.interval} ${r.window.unit}, same ${r.keep_same.join(' + ')}`);

// The buyer's own policy, written against typed extension data.
function acceptable(terms: CommercialTerms): boolean {
  const slips = terms.seller_adjustable_terms?.allowances ?? [];
  const tooLoose = slips.some((a) => a.constraint.kind === 'time_shift' && (a.constraint.max_shift.unit !== 'days' || a.constraint.max_shift.interval > 7));
  const cap = terms.makegood_units?.rules[0].max_units ?? 0; // free units for video 1, from the make-good rule
  return !tooLoose && cap >= 1;
}
log(`buyer policy (slips <= 7 days, make-goods required): ${acceptable(draft.commercial_terms) ? 'OK' : 'REJECT'}`);

step('3. Finalize -> committed proposal with an inventory hold (core, experimental hold_policy)');
const { proposals: [committed] } = await client.refineProposals({
  idempotency_key: 'finalize-0001-aaaaaaaa',
  refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
});
log(`committed ${committed.proposal_id}: hold placed ${committed.hold_placed_at}, expires ${committed.expires_at}`);
log(`terms_digest ${committed.terms_digest} covers the allowances and the make-good rules`);

step('4. Accept (the SDK recomputes terms_digest before signing)');
const { media_buy_id } = await client.acceptProposal({
  proposal: committed,
  idempotency_key: 'accept-0001-aaaaaaaaaa',
  account: { account_id: 'acc_brand_example' },
});
log(`media buy ${media_buy_id}, revision 1`);

step('5. The seller changes the live buy; the app reacts to the core change feed');
client.onChange(async (change) => {
  log(`change ${change.change_id} (${change.origin.kind}, ${change.reason}): ${change.summary}`);
  const { media_buys: [mb] } = await client.getMediaBuys({ media_buy_ids: [change.resource.resource_id!] });
  for (const a of mb.seller_adjustable_terms?.applied.filter((x) => x.revision === mb.revision) ?? []) {
    log(`  applied ${a.allowance_id}: ${a.path} ${a.previous_value} -> ${a.value}`);
  }
  for (const m of mb.makegood_units?.issued.filter((x) => x.revision === mb.revision) ?? []) {
    log(`  make-good ${m.makegood_id} under ${m.rule_id}: package ${m.package_id} (budget ${mb.packages.find((p) => p.package_id === m.package_id)?.budget})`);
  }
});

log('-- creator ill, video 1 moves 5 days (inside the 7-day allowance)');
seller.ops.creatorUnavailable(media_buy_id, 0, 5);
await new Promise((r) => setTimeout(r, 10));

log('-- video 2 cannot be made at all: the buyer asks for the make-good its terms allow');
// request_makegood is a typed method of this app's client: one method per task its extensions contribute.
const request = { media_buy_id, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed' } as const;
const answer = await client.requestMakegood({ ...request, idempotency_key: 'makegood-0001-aaaaaaa' });
if (answer.outcome === 'accepted') log(`request_makegood (${client.lastTaskCall?.name}): accepted, unit ${answer.makegood_id} in package ${answer.package_id}, revision ${answer.revision}`);
await new Promise((r) => setTimeout(r, 10));
const again = await client.requestMakegood({ ...request, idempotency_key: 'makegood-0002-aaaaaaa' });
if (again.outcome === 'rejected') log(`a second request under the same rule: ${again.rejection.code}: ${again.rejection.message}`);

log('-- the seller moves video 1 again, 4 more days (9 in total, past the allowance)');
seller.ops.rogueShift(media_buy_id, 0, 4);
await new Promise((r) => setTimeout(r, 10));
