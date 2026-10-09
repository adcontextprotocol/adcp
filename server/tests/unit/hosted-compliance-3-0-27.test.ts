import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadComplianceIndex,
  loadStoryboardFile,
  resolveStoryboardsForCapabilities,
  withExternalSchemaRoot,
} from '@adcp/sdk/testing';
import { getToolInputSchema, getToolResponseSchema } from '@adcp/sdk/schemas';
import {
  hostedComplianceOptions,
  hostedComplianceTarget,
} from '../../src/services/hosted-compliance-version.js';

describe('released 3.0.27 governance artifact carry-forward (#7797)', () => {
  it('advances the hosted 3.0 alias while preserving an exact 3.0.27 target', () => {
    const alias = hostedComplianceTarget('3.0');
    expect(alias.version).toMatch(/^3\.0\.\d+$/);
    // Future 3.0 patches may advance this alias, but it must never regress to
    // the old registered 3.0.25 ceiling once the fixed bundle is available.
    expect(Number(alias.version.split('.')[2])).toBeGreaterThanOrEqual(27);

    const pinned = hostedComplianceTarget('3.0.27');
    const options = hostedComplianceOptions(pinned);
    expect(options).toMatchObject({
      version: '3.0.27',
      complianceDir: join(process.cwd(), 'dist', 'compliance', '3.0.27'),
      schemaRoot: join(process.cwd(), 'dist', 'schemas', '3.0.27'),
    });
    expect(loadComplianceIndex(options)).toMatchObject({
      adcp_version: '3.0.27',
      published_version: '3.0.27',
    });
  });

  it('loads the fixed governance defaults and the exact external schema documents', async () => {
    const target = hostedComplianceTarget('3.0.27');
    const options = hostedComplianceOptions(target);
    const scenarios = ['approved', 'conditions', 'denied', 'denied_recovery'];
    const resolved = resolveStoryboardsForCapabilities({
      supported_protocols: ['media_buy'],
      specialisms: ['governance-aware-seller'],
      major_versions: [3],
      supported_versions: ['3.0'],
    }, options);

    for (const name of scenarios) {
      const storyboard = loadStoryboardFile(join(
        target.complianceDir, 'protocols', 'media-buy', 'scenarios', `governance_${name}.yaml`,
      ));
      expect(storyboard.context?.governance_agent_url).toBe('https://test-agent.adcontextprotocol.org');
      expect(resolved.storyboards.some(item => item.id === storyboard.id)).toBe(true);
      expect(resolved.not_applicable.some(item => item.storyboard_id === storyboard.id)).toBe(false);
    }

    await withExternalSchemaRoot(target.version, target.schemaRoot, async () => {
      for (const getDocument of [getToolInputSchema, getToolResponseSchema]) {
        const document = getDocument('sync_governance', { adcpVersion: target.version });
        expect(document).toBeDefined();
        expect(document?.requestedVersion).toBe('3.0.27');
        expect(document?.resolvedVersion).toBe('3.0.27');
        expect(document?.schema.$id).toContain('/schemas/3.0.27/');
      }
    });

    // The file-based discovery catalog must agree with the dynamic deployed
    // directory catalog without replacing unrelated current-line metadata.
    const discovery = JSON.parse(readFileSync(join(process.cwd(), 'dist', 'schemas', 'index.json'), 'utf8'));
    expect(discovery.versions.some((entry: { version: string }) => entry.version === '3.0.27')).toBe(true);
    expect(Number(discovery.aliases['v3.0'].split('.')[2])).toBeGreaterThanOrEqual(27);
    expect(discovery.latest_by_minor['3.0']).toBe(discovery.aliases['v3.0']);
  });
});
