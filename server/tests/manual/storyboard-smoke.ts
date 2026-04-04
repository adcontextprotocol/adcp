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

console.log('\n=== All storyboards exercised successfully ===');
