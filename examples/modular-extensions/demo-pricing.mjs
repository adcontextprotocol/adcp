#!/usr/bin/env node
// Walk-through of the hook design: a pricing model core does not have, added as an
// open-union branch by an extension, next to an explanatory rate card on a core
// quote. Prints the real payloads. Run `npm run build` first.
//
// Flow: get_products is discovery (steps 2-4): it shows the pricing options, including the
// explanatory rate card, which only the core-model option files can carry (the pricing_option
// extension point). The proposal comes from request_proposals (canonical proposal with commercial_terms and
// terms_digest), then refine_proposals finalize, then accept_proposal (steps 3-5).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdcpClient } from './lib/client.mjs';
import { INDEXED, createTvSeller } from './lib/mock-tv-seller.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const h = (s) => console.log(`\n== ${s} ${'='.repeat(Math.max(0, 74 - s.length))}`);
const short = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'digest' ? `${v.slice(0, 19)}…` : v)));
const show = (o) => console.log(JSON.stringify(short(o), null, 2).replace(/^/gm, '  '));
const ns = (dir) => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'packages', dir, 'extension.lock.json'), 'utf8'));
  return { EXTENSION_URI: lock.uri, EXTENSION_DIGEST: lock.digest, EXTENSION_MODULE_DIR: new URL(`./packages/${dir}/`, import.meta.url) };
};
const brief = { buying_mode: 'brief', brief: 'Prime time 25-54 in March' };
let n = 0;
const request = () => ({ idempotency_key: `request-demo-${String(++n).padStart(4, '0')}-aaaaa`, brief: 'Prime time 25-54 in March', brand: { domain: 'brand.example.com' } });

const seller = createTvSeller();
const tv = await createAdcpClient({ transport: seller.transport, extensions: [ns('ext-linear-tv-indexed-cpp')] });
const plain = await createAdcpClient({ transport: seller.transport });

h('1. Capabilities: the extension declaration with its capability fragment');
const caps = await tv.capabilities();
show(caps.declared_extensions[0]);

h('2. Discovery (get_products), buyer with the module: a core quote and the branch');
const { products } = await tv.getProducts(brief);
console.log(`  products: ${products.map((p) => `${p.product_id} [${p.channels}] -> ${p.pricing_options.map((o) => o.pricing_model.replace(/^https:\/\/[^#]+/, '…')).join(', ')}`).join('; ')}`);
show(products[0].pricing_options[1]);
const productReport = tv.check('/schemas/core/product.json', products[0], 'product');
for (const e of productReport.extensions) console.log(`  ${e.path} ${e.point}${e.branch ? `#${e.branch}` : ''} -> ${e.status}${e.warnings.length ? `; ${e.warnings.join('; ')}` : ''}`);

h('3. Buyer without the module: the branch is projected out; request_proposals prices core cpp');
const { products: plainProducts } = await plain.getProducts(brief);
console.log(`  get_products options on ${plainProducts[0].product_id}: ${plainProducts[0].pricing_options.map((o) => o.pricing_option_id).join(', ')}`);
const { proposals: [plainDraft] } = await plain.requestProposals(request());
show(plainDraft.commercial_terms.purchases[0].pricing);

h('4. The same plain buyer, if a seller sends the branch anyway: drop the option, fail closed on terms');
const leakyCatalog = await createAdcpClient({ transport: createTvSeller({ ignoreUnderstood: 'products' }).transport });
const leaked = await leakyCatalog.getProducts(brief);
console.log(`  options kept on ${leaked.products[0].product_id}: ${leaked.products[0].pricing_options.map((o) => o.pricing_option_id).join(', ')}`);
for (const w of leakyCatalog.lastReports[0].warnings) console.log(`  warning ${w.code}: ${w.message.replace(/@sha256:(.{8})\S*/, '@sha256:$1…')}`);
const leakyPlain = await createAdcpClient({ transport: createTvSeller({ ignoreUnderstood: true }).transport });
try {
  await leakyPlain.requestProposals(request());
} catch (e) {
  console.log(`  signed terms: ${e.code}: ${leakyPlain.lastReport.errors[0].message.replace(/@sha256:(.{8}).*? is/, '@sha256:$1… is')}`);
}

h('5. request_proposals -> refine_proposals finalize: the branch sits in purchases[].pricing, under terms_digest');
const { proposals: [draft] } = await tv.requestProposals(request());
const { proposals: [committed] } = await tv.refineProposals({ idempotency_key: 'finalize-demo-0001-aaaa', refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
const p0 = committed.commercial_terms.purchases[0];
show({ budget: p0.budget, pricing: p0.pricing, terms_digest: committed.terms_digest });
const { media_buy_id } = await tv.acceptProposal({ proposal: committed, idempotency_key: 'accept-demo-0001-aaaaaa', account: { account_id: 'acc_brand_example' } });

h('6. After booking: the seller fixes the market index; readback on the media buy');
seller.ops.fixMarketIndex(media_buy_id, 0.96);
const { media_buys: [mb] } = await tv.getMediaBuys({ media_buy_ids: [media_buy_id] });
show(mb.extensions_state);
console.log(`  buyer report: ${tv.lastReport.extensions.map((e) => `${e.point}${e.branch ? `#${e.branch}` : ''} ${e.status}`).join(', ')}; violations: ${tv.lastReport.violations.length}`);

h('7. After airing: delivered points x fixed rate, in the option currency');
show(seller.ops.invoice(media_buy_id, 104.1));
console.log();
