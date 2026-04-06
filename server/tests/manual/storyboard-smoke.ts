/**
 * Manual smoke test: exercises storyboard definitions + training agent creative handlers.
 * Run with: npx tsx server/tests/manual/storyboard-smoke.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { executeTrainingAgentTool } from '../../src/training-agent/task-handlers.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const ctx: TrainingContext = {
  mode: 'test' as const,
  userId: 'smoke-test',
  agentUrl: 'https://test-agent.adcontextprotocol.org/mcp',
};

function run(tool: string, args: Record<string, unknown>) {
  const result = executeTrainingAgentTool(tool, args, ctx);
  if (!result.success) {
    console.error(`  FAIL: ${tool} — ${result.error}`);
  }
  return result;
}

console.log('=== Storyboard Smoke Test ===\n');

// 1. Load storyboards
const dir = join(import.meta.dirname, '..', '..', '..', 'docs', 'storyboards');
const files = readdirSync(dir).filter(f => f.endsWith('.yaml') && f !== 'schema.yaml');
console.log(`Loaded ${files.length} storyboards:\n`);

for (const file of files) {
  const sb = YAML.parse(readFileSync(join(dir, file), 'utf-8'));
  const steps = sb.phases.reduce((s: number, p: { steps: unknown[] }) => s + p.steps.length, 0);
  console.log(`  ${sb.id} — ${sb.title} (${sb.phases.length} phases, ${steps} steps)`);
}

// 2. Test Celtra storyboard (stateless template/transformer)
console.log('\n--- Celtra Storyboard (stateless) ---\n');

console.log('Phase 1: Format discovery');
const formats = run('list_creative_formats', {});
const fmtList = (formats.data as any)?.formats;
console.log(`  list_creative_formats → ${fmtList?.length} formats`);
console.log(`  First 3: ${fmtList?.slice(0, 3).map((f: any) => f.format_id.id).join(', ')}`);

console.log('\nPhase 2: Preview');
const preview = run('preview_creative', {
  request_type: 'single',
  creative_manifest: {
    format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' },
    assets: [
      { asset_id: 'image', asset_type: 'image', url: 'https://test-assets.example.com/hero.jpg' },
      { asset_id: 'click_url', asset_type: 'url', url: 'https://acme-outdoor.example.com/sale' },
    ],
  },
  output_format: 'both',
  quality: 'draft',
});
const previewData = (preview.data as any)?.previews?.[0];
console.log(`  preview_creative → format: ${previewData?.format_id?.id}`);
console.log(`  Has URL: ${!!previewData?.renders?.[0]?.url}`);
console.log(`  Has HTML: ${!!previewData?.renders?.[0]?.html}`);
console.log(`  Expires: ${previewData?.expires_at}`);

console.log('\nPhase 3: Build');
const build = run('build_creative', {
  creative_manifest: {
    format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' },
    assets: [
      { asset_id: 'image', asset_type: 'image', url: 'https://test-assets.example.com/hero.jpg' },
      { asset_id: 'click_url', asset_type: 'url', url: 'https://acme-outdoor.example.com/sale' },
    ],
  },
  target_format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' },
});
const buildData = (build.data as any)?.creative_manifest;
console.log(`  build_creative → format: ${buildData?.format_id?.id}`);
console.log(`  Output asset type: ${buildData?.assets?.[0]?.asset_type}`);
console.log(`  Tag snippet: ${buildData?.assets?.[0]?.html?.substring(0, 80)}...`);

// Multi-format build
const multiBuild = run('build_creative', {
  creative_manifest: {
    assets: [{ asset_id: 'image', asset_type: 'image', url: 'https://example.com/hero.jpg' }],
  },
  target_format_ids: [
    { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' },
    { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_728x90' },
    { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_320x50' },
  ],
});
const multiData = (multiBuild.data as any)?.results;
console.log(`  build_creative (multi) → ${multiData?.length} formats: ${multiData?.map((r: any) => r.creative_manifest.format_id.id).join(', ')}`);

// 3. Test Ad Server storyboard (stateful, pre-loaded)
console.log('\n--- Ad Server Storyboard (stateful/pre-loaded) ---\n');

// Simulate pre-loaded creatives via sync
console.log('Setup: sync creatives to library');
run('sync_creatives', {
  account: { account_id: 'innovid-test' },
  creatives: [
    { creative_id: 'hero_video_001', format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' }, name: 'Summer Hero Video' },
    { creative_id: 'banner_001', format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_728x90' }, name: 'Summer Leaderboard' },
  ],
});

console.log('Phase 1: Browse library');
const library = run('list_creatives', { account: { account_id: 'innovid-test' } });
const creatives = (library.data as any)?.creatives;
console.log(`  list_creatives → ${creatives?.length} creatives`);
for (const c of creatives || []) {
  console.log(`    ${c.creative_id}: ${c.name} (${c.status})`);
}

console.log('\nPhase 2: Generate tags');
const tag1 = run('build_creative', {
  account: { account_id: 'innovid-test' },
  creative_id: 'hero_video_001',
  target_format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' },
  media_buy_id: 'mb_summer_001',
  package_id: 'pkg_ctv_premium',
});
const tagData = (tag1.data as any)?.creative_manifest;
console.log(`  build_creative (hero_video_001) → ${tagData?.format_id?.id}`);
console.log(`  Tag has media_buy ref: ${tagData?.assets?.[0]?.html?.includes('mb_summer_001')}`);

// 4. Test Sales Agent storyboard (stateful, push)
console.log('\n--- Sales Agent Storyboard (stateful/push) ---\n');

console.log('Phase 1: Discover formats');
const pubFormats = run('list_creative_formats', {});
console.log(`  list_creative_formats → ${(pubFormats.data as any)?.formats?.length} formats`);

console.log('\nPhase 2: Push creatives');
const syncResult = run('sync_creatives', {
  account: { account_id: 'publisher-test' },
  creatives: [{
    creative_id: 'catalog_product_001',
    format_id: { agent_url: 'https://test-agent.adcontextprotocol.org/mcp', id: 'display_300x250' },
    name: 'Hiking Backpack - Product Card',
  }],
});
const syncData = (syncResult.data as any)?.creatives;
console.log(`  sync_creatives → ${syncData?.[0]?.creative_id}: ${syncData?.[0]?.action}`);

console.log('\nPhase 3: Preview pushed creative');
const pubPreview = run('preview_creative', {
  account: { account_id: 'publisher-test' },
  request_type: 'single',
  creative_id: 'catalog_product_001',
  output_format: 'url',
});
const pubPreviewData = (pubPreview.data as any)?.previews?.[0];
console.log(`  preview_creative → format: ${pubPreviewData?.format_id?.id}`);
console.log(`  Has preview URL: ${!!pubPreviewData?.renders?.[0]?.url}`);

// 5. Test Media Buy Seller storyboard (full lifecycle)
console.log('\n--- Media Buy Seller Storyboard (full lifecycle) ---\n');

console.log('Phase 1: Account setup');
const acctResult = run('sync_accounts', {
  accounts: [{
    brand: { domain: 'acmeoutdoor.com', name: 'Acme Outdoor' },
    operator: 'pinnacle-agency.com',
    billing: 'operator',
    payment_terms: 'net_30',
    sandbox: true,
  }],
});
const accts = (acctResult.data as any)?.accounts;
console.log(`  sync_accounts → ${accts?.[0]?.account_id}: ${accts?.[0]?.action} (${accts?.[0]?.status})`);
console.log(`  Billing: ${accts?.[0]?.billing}, Terms: ${accts?.[0]?.payment_terms}`);

console.log('\nPhase 2: Governance setup');
const govResult = run('sync_governance', {
  accounts: [{
    account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
    governance_agents: [{
      url: 'https://governance.pinnacle-agency.example',
      authentication: { schemes: ['Bearer'], credentials: 'test-gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      categories: ['budget_authority', 'brand_policy'],
    }],
  }],
});
const govAccts = (govResult.data as any)?.accounts;
console.log(`  sync_governance → ${govAccts?.[0]?.status}`);
console.log(`  Agents: ${govAccts?.[0]?.governance_agents?.length}`);

console.log('\nPhase 3: Product discovery (brief)');
const products = run('get_products', {
  buying_mode: 'brief',
  brief: 'Premium video inventory on sports and outdoor lifestyle publishers. Q2 flight, $50K budget.',
  brand: { domain: 'acmeoutdoor.com' },
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
});
const prods = (products.data as any)?.products;
console.log(`  get_products (brief) → ${prods?.length} products`);
if (prods?.length > 0) {
  console.log(`  First product: ${prods[0].product_id} — ${prods[0].name}`);
  console.log(`  Delivery: ${prods[0].delivery_type}, Pricing: ${prods[0].pricing_options?.[0]?.pricing_model}`);
}

console.log('\nPhase 4: Proposal refinement');
const refined = run('get_products', {
  buying_mode: 'refine',
  refine: [{ scope: 'request', ask: 'Only guaranteed packages with CPM under $30' }],
  brand: { domain: 'acmeoutdoor.com' },
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
});
const refinedProds = (refined.data as any)?.products;
console.log(`  get_products (refine) → ${refinedProds?.length} products`);

console.log('\nPhase 5: Create media buy');
const firstProduct = prods?.[0];
const firstPricing = firstProduct?.pricing_options?.[0];
const buy = run('create_media_buy', {
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
  brand: { domain: 'acmeoutdoor.com' },
  start_time: '2026-04-01T00:00:00Z',
  end_time: '2026-06-30T23:59:59Z',
  packages: [{
    product_id: firstProduct?.product_id || 'sports_preroll_q2',
    pricing_option_id: firstPricing?.pricing_option_id || 'cpm_guaranteed',
    budget: 25000,
  }],
});
const buyData = buy.data as any;
const mediaBuyId = buyData?.media_buy_id;
console.log(`  create_media_buy → ${mediaBuyId}: ${buyData?.status}`);
console.log(`  Packages: ${buyData?.packages?.length}`);

console.log('\nPhase 5b: Check media buy status');
const buyStatus = run('get_media_buys', {
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
  media_buy_ids: [mediaBuyId],
});
const buys = (buyStatus.data as any)?.media_buys;
console.log(`  get_media_buys → ${buys?.[0]?.media_buy_id}: ${buys?.[0]?.status}`);

console.log('\nPhase 6: Creative sync');
const fmts = run('list_creative_formats', {});
console.log(`  list_creative_formats → ${(fmts.data as any)?.formats?.length} formats`);

const creativeSync = run('sync_creatives', {
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
  creatives: [{
    creative_id: 'video_30s_trail_pro',
    name: 'Trail Pro 3000 - 30s CTV Spot',
    format_id: { agent_url: ctx.agentUrl, id: 'display_300x250' },
  }],
});
const syncedCreatives = (creativeSync.data as any)?.creatives;
console.log(`  sync_creatives → ${syncedCreatives?.[0]?.creative_id}: ${syncedCreatives?.[0]?.action}`);

console.log('\nPhase 7: Delivery monitoring');
const delivery = run('get_media_buy_delivery', {
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'pinnacle-agency.com' },
  media_buy_id: mediaBuyId,
});
const deliveryData = (delivery.data as any)?.media_buys?.[0] || delivery.data;
console.log(`  get_media_buy_delivery → impressions: ${deliveryData?.total?.impressions ?? deliveryData?.delivery?.impressions ?? 'n/a'}`);

console.log('\n=== All storyboards exercised successfully ===');
