/**
 * Forward-introduced specialisms (adcp#8269).
 *
 * Runs against the checked-in `dist/compliance` artifacts and the real SDK
 * resolver, because the behaviour under test is exactly "what does
 * `resolveStoryboardsForCapabilities` do with a declared specialism this
 * release does not define".
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { CapabilityResolutionError, loadStoryboardFile, resolveStoryboardsForCapabilities } from '@adcp/sdk/testing';

import {
  complianceDirToleratingForwardIntroducedSpecialisms,
  declaredSpecialismsNotApplicableForTarget,
  forwardIntroducedSpecialisms,
  isForwardIntroducedSpecialism,
} from '../../src/compliance/forward-introduced-specialisms.js';
import {
  bundledComplianceVersions,
  compareComplianceVersions,
  hostedComplianceTarget,
} from '../../src/services/hosted-compliance-version.js';

const target30 = hostedComplianceTarget('3.0');
const target32 = hostedComplianceTarget('3.2');

function resolveAgainst(complianceDir: string, specialisms: string[]) {
  return resolveStoryboardsForCapabilities(
    {
      supported_protocols: ['media_buy', 'sponsored_intelligence'],
      specialisms,
      major_versions: [3],
      supported_versions: ['3.0'],
    },
    { version: target30.version, complianceDir, schemaRoot: target30.schemaRoot },
  );
}

describe('forwardIntroducedSpecialisms', () => {
  it('classifies specialisms a later release introduced, and nothing else', () => {
    // `sponsored-intelligence` ships in the 3.1 and 3.2 bundles only; 3.0 is a
    // closed stable line, so it can never gain one.
    expect(isForwardIntroducedSpecialism(target30.version, 'sponsored-intelligence')).toBe(true);
    expect(isForwardIntroducedSpecialism(target30.version, 'sales-dooh')).toBe(true);
    expect(isForwardIntroducedSpecialism(target30.version, 'sales-guaranteed')).toBe(false);
    expect(isForwardIntroducedSpecialism(target30.version, 'definitely-not-a-specialism')).toBe(false);
    expect(isForwardIntroducedSpecialism(target30.version, '../../etc/passwd')).toBe(false);
  });

  it('leaves deprecated specialisms the SDK aliases to a universal bundle alone', async () => {
    // `signed-requests` is still in the 3.0 and 3.1 enums but has no specialism
    // bundle in any release; @adcp/sdk honours it via
    // DEPRECATED_SPECIALISM_UNIVERSAL_ALIASES. Adding a synthetic index entry
    // for it would shadow that alias and turn a graded universal storyboard
    // into an empty bundle.
    expect(isForwardIntroducedSpecialism(target30.version, 'signed-requests')).toBe(false);
    const overlayDir = (await complianceDirToleratingForwardIntroducedSpecialisms(target30))!;
    const resolved = resolveAgainst(overlayDir, ['signed-requests']);
    expect(resolved.storyboards.map(sb => sb.id)).toContain('signed_requests');
  });

  it('resolves a release-line alias to that line\'s bundle', () => {
    expect(isForwardIntroducedSpecialism('3.0', 'sponsored-intelligence')).toBe(true);
    expect(isForwardIntroducedSpecialism('3.0', 'sales-guaranteed')).toBe(false);
    expect([...forwardIntroducedSpecialisms('not-a-version')]).toEqual([]);
  });

  it('has nothing to tolerate on the newest bundled release', () => {
    const newest = bundledComplianceVersions()
      .filter(version => /^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:-(?:beta|rc)\.[0-9]+)?$/.test(version))
      .sort(compareComplianceVersions)
      .at(-1)!;
    expect([...forwardIntroducedSpecialisms(newest)]).toEqual([]);
  });

  it('tolerates on the newest graded line only what its own bundle lacks', async () => {
    // A newer prerelease bundle (3.3 betas) may introduce specialisms the 3.2
    // graded line predates; none of them may be one 3.2 already defines.
    const target32Ids = new Set(
      (JSON.parse(readFileSync(join(target32.complianceDir, 'index.json'), 'utf8')) as {
        specialisms?: Array<{ id: string }>;
      }).specialisms?.map(specialism => specialism.id),
    );
    const tolerated = [...forwardIntroducedSpecialisms(target32.version)];
    for (const id of tolerated) expect(target32Ids.has(id)).toBe(false);
    if (tolerated.length === 0) {
      await expect(complianceDirToleratingForwardIntroducedSpecialisms(target32)).resolves.toBeUndefined();
    }
  });

  it('reports declared specialisms the graded release predates, deduplicated', () => {
    expect(declaredSpecialismsNotApplicableForTarget(target30.version, [
      'sales-guaranteed',
      'sponsored-intelligence',
      'sponsored-intelligence',
      'definitely-not-a-specialism',
      42,
      null,
    ])).toEqual(['sponsored-intelligence']);
    expect(declaredSpecialismsNotApplicableForTarget(target30.version, undefined)).toEqual([]);
  });
});

describe('capability resolution against a 3.0 target', () => {
  it('voids resolution without the overlay — the behaviour this fix replaces', () => {
    expect(() => resolveAgainst(target30.complianceDir, ['sales-guaranteed', 'sponsored-intelligence']))
      .toThrow(/no bundle exists/);
  });

  it('grades the rest of the run with a 3.1-only specialism declared', async () => {
    const overlayDir = await complianceDirToleratingForwardIntroducedSpecialisms(target30);
    expect(overlayDir).toBeTruthy();

    const baseline = resolveAgainst(target30.complianceDir, ['sales-guaranteed']);
    const tolerated = resolveAgainst(overlayDir!, ['sales-guaranteed', 'sponsored-intelligence']);
    // Concurrent runs on the same line share one staged copy.
    expect(await complianceDirToleratingForwardIntroducedSpecialisms(target30)).toBe(overlayDir);

    // Every storyboard the agent would have been graded on still runs.
    expect(tolerated.storyboards.map(sb => sb.id).sort())
      .toEqual(baseline.storyboards.map(sb => sb.id).sort());
    expect(tolerated.storyboards.length).toBeGreaterThan(0);

    // The specialism itself contributes no storyboards, so it can neither
    // fail the run nor earn vacuous credit.
    const specialismBundles = tolerated.bundles.filter(bundle => bundle.ref.kind === 'specialism');
    expect(specialismBundles.find(bundle => bundle.ref.id === 'sponsored-intelligence')?.storyboards)
      .toEqual([]);
    expect(specialismBundles.find(bundle => bundle.ref.id === 'sales-guaranteed')?.storyboards.length)
      .toBeGreaterThan(0);
  });

  it('keeps failing closed on a specialism no release defines', async () => {
    const overlayDir = (await complianceDirToleratingForwardIntroducedSpecialisms(target30))!;
    expect(() => resolveAgainst(overlayDir, ['definitely-not-a-specialism']))
      .toThrow(CapabilityResolutionError);
    try {
      resolveAgainst(overlayDir, ['sponsored-intelligence', 'definitely-not-a-specialism']);
      throw new Error('expected resolution to fail closed');
    } catch (err) {
      expect((err as CapabilityResolutionError).code).toBe('unknown_specialism');
    }
  });

  it('leaves a known specialism unchanged', async () => {
    const overlayDir = (await complianceDirToleratingForwardIntroducedSpecialisms(target30))!;
    const direct = resolveAgainst(target30.complianceDir, ['sales-guaranteed']);
    const viaOverlay = resolveAgainst(overlayDir, ['sales-guaranteed']);
    expect(viaOverlay.storyboards.map(sb => sb.id)).toEqual(direct.storyboards.map(sb => sb.id));
    expect(viaOverlay.bundles.map(bundle => `${bundle.ref.kind}:${bundle.ref.id}`))
      .toEqual(direct.bundles.map(bundle => `${bundle.ref.kind}:${bundle.ref.id}`));
  });

  it('keeps declared test kits physically inside the overlay root', async () => {
    // @adcp/sdk resolves a storyboard's declared prerequisites.test_kit and
    // requires the realpath to sit under the realpath of complianceDir. A
    // symlinked overlay resolves back into dist/ and throws mid-run, which
    // would void the run this fix exists to rescue.
    const overlayDir = (await complianceDirToleratingForwardIntroducedSpecialisms(target30))!;
    const storyboard = loadStoryboardFile(
      join(target30.complianceDir, 'protocols', 'media-buy', 'index.yaml'),
    ) as { prerequisites?: { test_kit?: string } };
    const declared = storyboard.prerequisites?.test_kit;
    expect(declared).toBeTruthy();

    const physicalRoot = realpathSync(overlayDir);
    const physicalKit = realpathSync(join(overlayDir, declared!));
    expect(physicalKit.startsWith(physicalRoot + sep)).toBe(true);
    expect(readFileSync(physicalKit, 'utf8')).toEqual(
      readFileSync(join(target30.complianceDir, declared!), 'utf8'),
    );
  });

  it('never writes into the released compliance artifact', async () => {
    await complianceDirToleratingForwardIntroducedSpecialisms(target30);
    const released = JSON.parse(
      readFileSync(join(target30.complianceDir, 'index.json'), 'utf8'),
    ) as { specialisms: Array<{ id: string }> };
    expect(released.specialisms.map(entry => entry.id)).not.toContain('sponsored-intelligence');
  });
});
