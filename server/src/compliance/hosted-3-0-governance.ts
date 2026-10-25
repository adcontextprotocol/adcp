/**
 * Hosted applicability erratum for the immutable 3.0 governance scenarios
 * (#8363). Their specialism's own contract says unclaimed governance is not
 * applicable, but the protocol bundle selects the scenarios without a gate.
 * Move them into their specialism in a private copy. Unlike a runtime gate,
 * this excludes unclaimed scenarios from 3.0's bundle rollup too.
 */
import { access, cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HostedComplianceTarget } from '../services/hosted-compliance-version.js';

export const HOSTED_3_0_GOVERNANCE_POLICY = 'hosted-compliance-v1-3.0-governance-specialism-scope';

const SCENARIOS = ['approved', 'conditions', 'denied', 'denied_recovery'];
const overlayDirs = new Map<string, Promise<string | undefined>>();

/**
 * Copy rather than symlink: the SDK requires test kits' physical paths to sit
 * under the compliance root. Cache the in-flight copy per input directory so
 * concurrent runs share it, including retries using the forward-specialism
 * overlay. Failed staging rejects the run and remains retryable.
 */
export function complianceDirWith3_0GovernanceScoping(
  target: HostedComplianceTarget,
  complianceDir = target.complianceDir,
): Promise<string | undefined> {
  if (!/^3\.0\.\d+$/.test(target.version)) return Promise.resolve(undefined);

  const cached = overlayDirs.get(complianceDir);
  if (cached) return cached;

  const staging = stageGovernanceOverlay(complianceDir).catch(error => {
    overlayDirs.delete(complianceDir);
    throw error;
  });
  overlayDirs.set(complianceDir, staging);
  return staging;
}

async function stageGovernanceOverlay(complianceDir: string): Promise<string | undefined> {
  const specialismPath = join('specialisms', 'governance-aware-seller');
  try {
    await access(join(complianceDir, specialismPath, 'index.yaml'));
  } catch (error) {
    // Releases predating the specialism retain their original selection.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const overlayDir = await mkdtemp(join(tmpdir(), 'adcp-3-0-governance-'));
  try {
    await cp(complianceDir, overlayDir, { recursive: true });
    const scenariosDir = join(overlayDir, specialismPath, 'scenarios');
    await mkdir(scenariosDir, { recursive: true });
    for (const scenario of SCENARIOS) {
      const filename = `governance_${scenario}.yaml`;
      try {
        await rename(
          join(overlayDir, 'protocols', 'media-buy', 'scenarios', filename),
          join(scenariosDir, filename),
        );
      } catch (error) {
        // Some older exact releases do not contain every scenario.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return overlayDir;
  } catch (error) {
    await rm(overlayDir, { recursive: true, force: true });
    throw error;
  }
}
