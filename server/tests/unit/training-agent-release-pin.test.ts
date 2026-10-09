import { describe, expect, it } from 'vitest';
import {
  resolveServedAdcpVersion,
  resolveServedAdcpVersionForTool,
} from '../../src/training-agent/task-handlers.js';
import {
  supportsAccountChangeFeed,
  supportsGetProductsRejected,
  supportsReliableReporting,
  supportsReportingStatus,
  supportsSellerGovernanceDiscovery,
  TRAINING_AGENT_CURRENT_ADCP_RELEASE,
  TRAINING_AGENT_CURRENT_ADCP_VERSION,
  TRAINING_AGENT_DEFAULT_ADCP_VERSION,
  TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS,
} from '../../src/training-agent/types.js';

describe('training agent 3.2 release-line pin', () => {
  it('derives the release line from the current bundle', () => {
    expect(TRAINING_AGENT_CURRENT_ADCP_RELEASE).toBe('3.2');
    expect(TRAINING_AGENT_CURRENT_ADCP_VERSION.startsWith(`${TRAINING_AGENT_CURRENT_ADCP_RELEASE}`)).toBe(true);
    // Unpinned callers keep the deliberate 3.0 default.
    expect(TRAINING_AGENT_DEFAULT_ADCP_VERSION).toBe('3.0');
  });

  it('advertises the release line and keeps the exact rc.7 pin, without duplicates', () => {
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS).toContain(TRAINING_AGENT_CURRENT_ADCP_VERSION);
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS).toContain('3.2-rc.7');
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.at(-1)).toBe(TRAINING_AGENT_CURRENT_ADCP_RELEASE);
    expect(new Set(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS).size).toBe(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.length);
  });

  it.each([
    [{ adcp_version: '3.2' }, '3.2'],
    [{ adcp_version: '3.2', adcp_major_version: 3 }, '3.2'],
    // Patch-bearing values are not valid wire pins but still land on 3.2.
    [{ adcp_version: '3.2.0' }, '3.2'],
    [{ adcp_version: '3.2.1' }, '3.2'],
    [{ adcp_version: '3.2-rc.7' }, '3.2-rc.7'],
    [{ adcp_version: '3.1' }, '3.1'],
    [{ adcp_version: '3.3' }, '3.2'],
    [{ adcp_major_version: 3 }, '3.2'],
    [{}, '3.0'],
  ])('resolves %j to %s', (args, served) => {
    expect(resolveServedAdcpVersion(args)).toEqual({ ok: true, servedVersion: served });
  });

  it('still rejects unlisted prerelease pins', () => {
    expect(resolveServedAdcpVersion({ adcp_version: '3.2-rc.1' })).toMatchObject({
      ok: false,
      field: 'adcp_version',
    });
  });

  it('never downshifts a release pin onto a prerelease when the release line is not advertised', () => {
    expect(resolveServedAdcpVersion({ adcp_version: '3.2' }, ['3.0', '3.1', '3.2-rc.7']))
      .toEqual({ ok: true, servedVersion: '3.1' });
  });

  it('serves compact-lifecycle discovery tools at the release line', () => {
    expect(resolveServedAdcpVersionForTool('list_products', { adcp_version: '3.2' }))
      .toEqual({ ok: true, servedVersion: '3.2' });
    expect(resolveServedAdcpVersionForTool('list_products', {}))
      .toEqual({ ok: true, servedVersion: '3.2' });
  });

  it('gates every 3.2 surface on for the release-line pin', () => {
    expect(supportsGetProductsRejected('3.2')).toBe(true);
    expect(supportsSellerGovernanceDiscovery('3.2')).toBe(true);
    expect(supportsReportingStatus('3.2')).toBe(true);
    expect(supportsReliableReporting('3.2')).toBe(true);
    // Production keeps the account change feed dark regardless of version.
    if (process.env.NODE_ENV !== 'production') {
      expect(supportsAccountChangeFeed('3.2')).toBe(true);
    }
  });
});
