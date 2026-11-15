import type { TestOptions } from '@adcp/sdk/testing';

/**
 * Whether an AdCP version pin names a prerelease, in either precision:
 * `3.3.0-beta.6` (release) or `3.3-beta.6` (wire).
 */
export function isPrereleaseAdcpVersion(version: string | undefined): boolean {
  return version !== undefined && /^[1-9][0-9]*\.[0-9]+(?:\.[0-9]+)?-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(version);
}

/**
 * The version envelope that keeps capability discovery pinned to a
 * prerelease wire pin.
 *
 * @adcp/sdk 17.0.0-beta.23 and later send capability discovery unpinned when
 * the run's pin is a prerelease, then profile whatever the agent serves
 * unpinned, usually its stable line. A conformant agent serves a prerelease
 * only to an exact pin, so every capability gate for the prerelease surface is
 * evaluated against the stable surface and skips (adcp-client#3715). An
 * explicit `auto` envelope keeps discovery pinned. Stable pins return
 * `undefined` and keep the SDK default, including its unpinned and
 * `major-only` discovery fallbacks.
 */
export function prereleaseDiscoveryEnvelope(
  wirePin: string | undefined,
): TestOptions['versionEnvelope'] | undefined {
  return isPrereleaseAdcpVersion(wirePin) ? 'auto' : undefined;
}
