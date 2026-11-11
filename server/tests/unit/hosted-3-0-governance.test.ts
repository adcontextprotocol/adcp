import { readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildComplianceBundleResults,
  comply,
  listDefaultAssertions,
  resolveBundleOrStoryboard,
  resolveStoryboardsForCapabilities,
  type Storyboard,
  type StoryboardResult,
} from '@adcp/sdk/testing';

import { complianceDirWith3_0GovernanceScoping } from '../../src/compliance/hosted-3-0-governance.js';
import { complianceDirToleratingForwardIntroducedSpecialisms } from '../../src/compliance/forward-introduced-specialisms.js';
import { hostedComplianceOptions, hostedComplianceTarget, withHostedComplianceRunOptions } from '../../src/services/hosted-compliance-version.js';

const SCENARIOS = ['approved', 'conditions', 'denied', 'denied_recovery'];
const GOVERNANCE_IDS = SCENARIOS.map(name => `media_buy_seller/governance_${name}`);

function resolveSeller(complianceDir: string, specialisms: string[] = []) {
  return resolveStoryboardsForCapabilities({
    supported_protocols: ['media_buy'],
    specialisms,
    major_versions: [3],
    supported_versions: ['3.0'],
  }, { complianceDir });
}

/** Passing evidence for other scenarios, with the reported peer-call setup gap. */
function resultsFor(storyboards: Storyboard[]): StoryboardResult[] {
  return storyboards.map(storyboard => ({
    storyboard_id: storyboard.id,
    overall_passed: !GOVERNANCE_IDS.includes(storyboard.id),
    passed_count: GOVERNANCE_IDS.includes(storyboard.id) ? 0 : 1,
    failed_count: 0,
    skipped_count: GOVERNANCE_IDS.includes(storyboard.id) ? 1 : 0,
    phases: [],
  } as unknown as StoryboardResult));
}

describe('hosted 3.0 governance applicability (#8363)', () => {
  it.each(['3.0.27', '3.0.28', '3.0'])('excludes unclaimed governance from %s selection and its media-buy rollup', async version => {
    const target = hostedComplianceTarget(version);
    const released = resolveSeller(target.complianceDir);
    expect(released.storyboards.map(storyboard => storyboard.id)).toEqual(expect.arrayContaining(GOVERNANCE_IDS));
    expect(buildComplianceBundleResults(released.bundles, resultsFor(released.storyboards))
      .find(bundle => bundle.id === 'media-buy')?.status).toBe('partial');

    const overlayDir = (await complianceDirWith3_0GovernanceScoping(target))!;
    const scoped = resolveSeller(overlayDir);
    expect(scoped.storyboards.map(storyboard => storyboard.id).sort()).toEqual(
      released.storyboards.map(storyboard => storyboard.id).filter(id => !GOVERNANCE_IDS.includes(id)).sort(),
    );
    expect(scoped.bundles.find(bundle => bundle.ref.id === 'media-buy')?.storyboards
      .some(storyboard => GOVERNANCE_IDS.includes(storyboard.id))).toBe(false);
    expect(buildComplianceBundleResults(scoped.bundles, resultsFor(scoped.storyboards))
      .find(bundle => bundle.id === 'media-buy')?.status).toBe('passing');
  });

  it('retains all four unchanged scenarios for a declared governance-aware seller', async () => {
    const target = hostedComplianceTarget('3.0.28');
    const overlayDir = (await complianceDirWith3_0GovernanceScoping(target))!;
    const scoped = resolveSeller(overlayDir, ['governance-aware-seller']);
    const governanceBundle = scoped.bundles.find(bundle => bundle.ref.id === 'governance-aware-seller')!;

    expect(governanceBundle.storyboards.map(storyboard => storyboard.id)).toEqual(expect.arrayContaining(GOVERNANCE_IDS));
    // A claimed specialism keeps its setup gaps; moving the files must never
    // turn missing peer tools into passing governance evidence.
    expect(buildComplianceBundleResults(scoped.bundles, resultsFor(scoped.storyboards))
      .find(bundle => bundle.id === 'governance-aware-seller')?.status).toBe('partial');

    for (const name of SCENARIOS) {
      const filename = `governance_${name}.yaml`;
      expect(readFileSync(join(overlayDir, 'specialisms/governance-aware-seller/scenarios', filename), 'utf8'))
        .toBe(readFileSync(join(target.complianceDir, 'protocols/media-buy/scenarios', filename), 'utf8'));
      // Explicit diagnostic runs still resolve the existing public IDs.
      expect(resolveBundleOrStoryboard(`media_buy_seller/governance_${name}`, {
        ...hostedComplianceOptions(target), complianceDir: overlayDir,
      }).map(storyboard => storyboard.id)).toEqual([`media_buy_seller/governance_${name}`]);
    }
  });

  it('preserves the normal sales specialism and keeps test kits inside the scratch root', async () => {
    const target = hostedComplianceTarget('3.0.28');
    const overlayDir = (await complianceDirWith3_0GovernanceScoping(target))!;
    const scoped = resolveSeller(overlayDir, ['sales-guaranteed']);
    expect(scoped.bundles.some(bundle => bundle.ref.id === 'sales-guaranteed')).toBe(true);
    expect(scoped.storyboards.some(storyboard => GOVERNANCE_IDS.includes(storyboard.id))).toBe(false);
    const kit = 'test-kits/acme-outdoor.yaml';
    expect(realpathSync(join(overlayDir, kit)).startsWith(realpathSync(overlayDir) + sep)).toBe(true);
    expect(readFileSync(join(overlayDir, kit), 'utf8')).toBe(readFileSync(join(target.complianceDir, kit), 'utf8'));
    expect(await complianceDirWith3_0GovernanceScoping(target)).toBe(overlayDir);
  });

  it('composes with the forward-specialism retry without restoring unclaimed governance', async () => {
    const target = hostedComplianceTarget('3.0.28');
    const forwardDir = (await complianceDirToleratingForwardIntroducedSpecialisms(target))!;
    const overlayDir = (await complianceDirWith3_0GovernanceScoping(target, forwardDir))!;
    const resolved = resolveSeller(overlayDir, ['sales-guaranteed', 'sponsored-intelligence']);
    expect(resolved.bundles.find(bundle => bundle.ref.id === 'sponsored-intelligence')?.storyboards).toEqual([]);
    expect(resolved.storyboards.some(storyboard => GOVERNANCE_IDS.includes(storyboard.id))).toBe(false);
    expect(resolveSeller(overlayDir, ['governance-aware-seller']).storyboards.map(storyboard => storyboard.id))
      .toEqual(expect.arrayContaining(GOVERNANCE_IDS));
  });

  it.each(['3.1.29', '3.2.6'])('keeps %s on its released bundle', async version => {
    await expect(complianceDirWith3_0GovernanceScoping(hostedComplianceTarget(version))).resolves.toBeUndefined();
  });

  it('runs the real SDK agent-wide without governance calls or a Partial media-buy bundle', async () => {
    const target = hostedComplianceTarget('3.0.28');
    const fixtureDir = await mkdtemp(join(tmpdir(), 'adcp-governance-regression-'));
    try {
      // Isolate the reported selection/rollup from unrelated conformance
      // scenarios. Governance files and the specialism index stay verbatim.
      const index = JSON.parse(readFileSync(join(target.complianceDir, 'index.json'), 'utf8'));
      index.universal = [];
      index.protocols = index.protocols.filter((entry: { id: string }) => entry.id === 'media-buy');
      index.specialisms = index.specialisms.filter((entry: { id: string }) => entry.id === 'governance-aware-seller');
      await writeFile(join(fixtureDir, 'index.json'), JSON.stringify(index));
      const protocolDir = join(fixtureDir, 'protocols/media-buy');
      await mkdir(join(protocolDir, 'scenarios'), { recursive: true });
      await cp(join(target.complianceDir, 'specialisms/governance-aware-seller'),
        join(fixtureDir, 'specialisms/governance-aware-seller'), { recursive: true });
      await cp(join(target.complianceDir, 'test-kits'), join(fixtureDir, 'test-kits'), { recursive: true });
      for (const name of SCENARIOS) {
        await cp(join(target.complianceDir, 'protocols/media-buy/scenarios', `governance_${name}.yaml`),
          join(protocolDir, 'scenarios', `governance_${name}.yaml`));
      }
      // A small successful baseline beside the unchanged regression cases.
      await writeFile(join(protocolDir, 'index.yaml'), JSON.stringify({
        id: 'media_buy_seller', version: '1.0.0', title: 'Seller capabilities',
        category: 'media_buy_seller', track: 'media_buy', required_tools: ['get_adcp_capabilities'],
        agent: { interaction_model: 'media_buy_seller', capabilities: [] },
        caller: { role: 'buyer_agent' },
        // This fixture proves capability discovery only; lifecycle invariant
        // observations belong to the unchanged governance scenarios.
        invariants: { disable: listDefaultAssertions().filter(id => id !== 'context.no_secret_echo') },
        phases: [{ id: 'discovery', title: 'Discovery', steps: [{
          id: 'capabilities', title: 'Discover capabilities', task: 'get_adcp_capabilities',
          sample_request: {}, validations: [],
        }] }],
      }));

      const calls: string[] = [];
      const capabilities = {
        adcp: { major_versions: [3], idempotency: { supported: false } },
        supported_protocols: ['media_buy'], specialisms: [],
        account: { supported_billing: ['operator'] },
      };
      const fetchFn: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const message = await request.json() as { id?: number; method: string; params?: { name?: string } };
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        if (message.method === 'initialize') {
          result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Seller', version: '1.0.0' } };
        } else if (message.method === 'tools/list') {
          result = { tools: ['get_adcp_capabilities', 'get_products', 'create_media_buy'].map(name => ({
            name, inputSchema: { type: 'object', properties: {} },
          })) };
        } else if (message.method === 'tools/call') {
          calls.push(message.params!.name!);
          if (message.params!.name !== 'get_adcp_capabilities') throw new Error(`Unexpected task: ${message.params!.name}`);
          result = { structuredContent: capabilities, content: [{ type: 'text', text: JSON.stringify(capabilities) }] };
        } else {
          throw new Error(`Unexpected method: ${message.method}`);
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const overlayDir = (await complianceDirWith3_0GovernanceScoping(target, fixtureDir))!;
      try {
        const result = await comply('https://seller.example/mcp', withHostedComplianceRunOptions({
          complianceDir: overlayDir,
          transport: { trustedFetchFn: fetchFn },
          timeout_ms: 30_000,
        }, target));
        expect(result.storyboards_executed).toEqual(['media_buy_seller']);
        expect(result.failures ?? []).toEqual([]);
        expect(result.bundle_results?.find(bundle => bundle.id === 'media-buy')?.status).toBe('passing');
        expect(result.tracks.find(track => track.track === 'media_buy')?.status).toBe('pass');
        expect(calls.length).toBeGreaterThan(0);
        expect(new Set(calls)).toEqual(new Set(['get_adcp_capabilities']));
      } finally {
        await rm(overlayDir, { recursive: true, force: true });
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
