import { existsSync, readdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { registerExternalSchemaRoot } from '@adcp/sdk/testing';
import type {
  AgentCapabilities,
  ComplyOptions,
  ResolveOptions,
  ResolvedStoryboards,
  StoryboardRunOptions,
  TestOptions,
} from '@adcp/sdk/testing';
import { SUPPORTED_BADGE_VERSIONS } from './adcp-taxonomy.js';

export const DEFAULT_HOSTED_COMPLIANCE_LINE = '3.0';

export interface HostedComplianceTarget {
  requested: string;
  version: string;
  complianceDir: string;
  schemaRoot: string;
}

type HostedResolveOptions = ResolveOptions & { schemaRoot: string };

const registeredSchemaRoots = new Set<string>();
const SDK_STORYBOARD_RESOLVER_PATCHED = Symbol.for('adcp.hostedStoryboardResolverPatched');
const hostedComplianceContext = new AsyncLocalStorage<HostedComplianceTarget>();

type SdkStoryboardResolverFn = ((
  caps: AgentCapabilities,
  options?: ResolveOptions,
) => ResolvedStoryboards) & {
  [SDK_STORYBOARD_RESOLVER_PATCHED]?: true;
};

function repoPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

function schemaRootCacheKey(version: string): string {
  const stable = version.match(/^([1-9][0-9]*)\.([0-9]+)\.[0-9]+$/);
  return stable ? `${stable[1]}.${stable[2]}` : version;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionSortKey(version: string): number[] {
  const match = version.match(/^([1-9][0-9]*)\.([0-9]+)\.([0-9]+)(?:-beta\.([0-9]+))?$/);
  if (!match) return [0, 0, 0, -1];

  const [, major, minor, patch, beta] = match;
  return [
    Number.parseInt(major, 10),
    Number.parseInt(minor, 10),
    Number.parseInt(patch, 10),
    beta === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(beta, 10),
  ];
}

function compareVersions(a: string, b: string): number {
  const aParts = versionSortKey(a);
  const bParts = versionSortKey(b);
  for (let i = 0; i < aParts.length; i++) {
    const diff = aParts[i] - bParts[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function prereleaseComplianceLine(version: string): string | undefined {
  const fullSemver = version.match(/^([1-9][0-9]*)\.([0-9]+)\.[0-9]+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*(?:\+[0-9A-Za-z.-]+)?$/);
  if (fullSemver) return `${fullSemver[1]}.${fullSemver[2]}`;

  const wirePrecision = version.match(/^([1-9][0-9]*)\.([0-9]+)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*(?:\+[0-9A-Za-z.-]+)?$/);
  return wirePrecision ? `${wirePrecision[1]}.${wirePrecision[2]}` : undefined;
}

function complianceReleaseLine(version: string): string | undefined {
  const match = version.match(/^([1-9][0-9]*\.[0-9]+)(?:\.|$|-)/);
  return match ? match[1] : undefined;
}

function stableLineForHostedPrereleaseTarget(target: HostedComplianceTarget): string | undefined {
  if (!isDefaultHostedComplianceTarget(target)) return undefined;

  const line = prereleaseComplianceLine(target.version);
  return line === target.requested ? line : undefined;
}

export function hostedSupportedVersionsForCompliance(
  supportedVersions: readonly string[] | undefined,
  target: HostedComplianceTarget,
): string[] | undefined {
  if (!supportedVersions || supportedVersions.length === 0) return supportedVersions ? [] : undefined;

  const line = stableLineForHostedPrereleaseTarget(target);
  if (!line || !supportedVersions.includes(line) || supportedVersions.includes(target.version)) {
    return [...supportedVersions];
  }

  return [target.version, ...supportedVersions];
}

export function hostedCapabilitiesForCompliance(
  caps: AgentCapabilities,
  target: HostedComplianceTarget,
): AgentCapabilities {
  const supported_versions = hostedSupportedVersionsForCompliance(caps.supported_versions, target);
  return supported_versions === caps.supported_versions ? caps : { ...caps, supported_versions };
}

export function withHostedComplianceCompatibility<T>(
  target: HostedComplianceTarget,
  fn: () => T,
): T {
  return hostedComplianceContext.run(target, fn);
}

function installHostedStoryboardResolverPatch(): void {
  // The hosted badge line can resolve to a checked-in prerelease bundle before
  // GA (for example public target `3.1` backed by cache `3.1.0-beta.7`).
  // Keep the compatibility shim scoped to storyboard compliance resolution;
  // normal AdCP wire-version negotiation still requires exact prerelease pins.
  let complianceModule: { resolveStoryboardsForCapabilities?: SdkStoryboardResolverFn };
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = resolve(require.resolve('@adcp/sdk/package.json'), '..');
    complianceModule = require(join(packageRoot, 'dist', 'lib', 'testing', 'storyboard', 'compliance.js')) as {
      resolveStoryboardsForCapabilities?: SdkStoryboardResolverFn;
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install hosted storyboard resolver patch: ${detail}`);
  }

  const original = complianceModule.resolveStoryboardsForCapabilities;
  if (!original || original[SDK_STORYBOARD_RESOLVER_PATCHED]) return;

  const patched: SdkStoryboardResolverFn = (caps, options) => {
    const target = hostedComplianceContext.getStore();
    return original(target ? hostedCapabilitiesForCompliance(caps, target) : caps, options);
  };
  patched[SDK_STORYBOARD_RESOLVER_PATCHED] = true;
  complianceModule.resolveStoryboardsForCapabilities = patched;
}

function complianceVersions(): string[] {
  const complianceRoot = repoPath('dist', 'compliance');
  return readdirSync(complianceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(join(complianceRoot, name, 'index.json')));
}

function latestStableComplianceVersionForLine(line: string): string {
  const complianceRoot = repoPath('dist', 'compliance');
  const releaseRe = new RegExp(`^${escapeRegex(line)}\\.\\d+$`);
  const versions = complianceVersions()
    .filter(name => releaseRe.test(name))
    .sort(compareVersions);

  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(
      `No checked-in AdCP ${line}.x compliance cache found at ${complianceRoot}. Run npm run build:compliance.`,
    );
  }
  return latest;
}

function latestBetaComplianceVersionForLine(line: string): string {
  const complianceRoot = repoPath('dist', 'compliance');
  const betaRe = new RegExp(`^${escapeRegex(line)}\\.0-beta\\.\\d+$`);
  const versions = complianceVersions()
    .filter(name => betaRe.test(name))
    .sort(compareVersions);

  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(
      `No checked-in AdCP ${line}-beta compliance cache found at ${complianceRoot}. Run npm run build:compliance.`,
    );
  }
  return latest;
}

function latestBadgeEligibleComplianceVersionForLine(line: string): string {
  try {
    return latestStableComplianceVersionForLine(line);
  } catch (stableError) {
    if (line !== DEFAULT_HOSTED_COMPLIANCE_LINE) {
      throw stableError;
    }

    // Only the default line may temporarily fall back to a prerelease cache
    // while its stable compliance bundle is being staged. Other lines must be
    // selected explicitly via their prerelease alias (for example 3.1-beta).
    return latestBetaComplianceVersionForLine(line);
  }
}

export const DEFAULT_HOSTED_COMPLIANCE_VERSION =
  latestBadgeEligibleComplianceVersionForLine(DEFAULT_HOSTED_COMPLIANCE_LINE);

export function hostedComplianceDir(version = DEFAULT_HOSTED_COMPLIANCE_VERSION): string {
  return repoPath('dist', 'compliance', version);
}

export function hostedSchemaRoot(version = DEFAULT_HOSTED_COMPLIANCE_VERSION): string {
  return repoPath('dist', 'schemas', version);
}

function hostedSchemaRootForVersion(version: string, target: HostedComplianceTarget): string {
  return version === target.version ? target.schemaRoot : hostedSchemaRoot(version);
}

export function resolveHostedComplianceVersion(target: string = DEFAULT_HOSTED_COMPLIANCE_LINE): string {
  if (/^[1-9][0-9]*\.[0-9]+$/.test(target)) {
    return latestBadgeEligibleComplianceVersionForLine(target);
  }
  const betaMatch = target.match(/^([1-9][0-9]*\.[0-9]+)-beta$/);
  if (betaMatch) {
    return latestBetaComplianceVersionForLine(betaMatch[1]);
  }
  if (/^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/.test(target)) {
    return target;
  }
  throw new Error(
    `Unsupported AdCP compliance target "${target}". Use a line alias like 3.0, a beta alias like 3.1-beta, or an exact bundled version like 3.0.12.`,
  );
}

export function hostedComplianceTarget(target: string = DEFAULT_HOSTED_COMPLIANCE_LINE): HostedComplianceTarget {
  const version = resolveHostedComplianceVersion(target);
  return {
    requested: target,
    version,
    complianceDir: hostedComplianceDir(version),
    schemaRoot: hostedSchemaRoot(version),
  };
}

export function isDefaultHostedComplianceTarget(target: HostedComplianceTarget): boolean {
  return target.requested === DEFAULT_HOSTED_COMPLIANCE_LINE &&
    target.version === DEFAULT_HOSTED_COMPLIANCE_VERSION;
}

export function badgeEligibleVersionsForHostedComplianceTarget(
  target: HostedComplianceTarget,
): readonly string[] {
  if (target.requested.endsWith('-beta') || target.version.includes('-beta.')) {
    return [];
  }

  const line = complianceReleaseLine(target.requested) ?? complianceReleaseLine(target.version);
  return line && (SUPPORTED_BADGE_VERSIONS as readonly string[]).includes(line) ? [line] : [];
}

function assertHostedArtifacts(version: string): void {
  const complianceDir = hostedComplianceDir(version);
  const schemaRoot = hostedSchemaRoot(version);

  if (!existsSync(join(complianceDir, 'index.json'))) {
    throw new Error(
      `Hosted AdCP compliance cache ${version} not found at ${complianceDir}. Run npm run build:compliance.`,
    );
  }

  if (!existsSync(join(schemaRoot, 'bundled')) && !existsSync(join(schemaRoot, 'core'))) {
    throw new Error(
      `Hosted AdCP schema bundle ${version} not found at ${schemaRoot}. Run npm run build:schemas.`,
    );
  }
}

export function registerHostedComplianceSchemaRoot(version = DEFAULT_HOSTED_COMPLIANCE_VERSION): void {
  const cacheKey = schemaRootCacheKey(version);
  if (registeredSchemaRoots.has(cacheKey)) return;

  assertHostedArtifacts(version);

  registerExternalSchemaRoot(version, hostedSchemaRoot(version));
  registeredSchemaRoots.add(cacheKey);
}

export function hostedComplianceOptions(target: HostedComplianceTarget): HostedResolveOptions {
  registerHostedComplianceSchemaRoot(target.version);
  return {
    version: target.version,
    complianceDir: target.complianceDir,
    schemaRoot: target.schemaRoot,
  };
}

export function withHostedComplianceOptions<T extends Partial<ResolveOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
): (T extends undefined ? HostedResolveOptions : NonNullable<T> & HostedResolveOptions) {
  const input = (options ?? {}) as Partial<ResolveOptions>;
  const version = resolveHostedComplianceVersion(input.version ?? target.version);
  registerHostedComplianceSchemaRoot(version);

  return {
    ...input,
    version,
    complianceDir: input.complianceDir ?? (version === target.version ? target.complianceDir : hostedComplianceDir(version)),
    schemaRoot: input.schemaRoot ?? hostedSchemaRootForVersion(version, target),
  } as T extends undefined ? HostedResolveOptions : NonNullable<T> & HostedResolveOptions;
}

export function withHostedComplianceRunOptions<T extends Partial<ComplyOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
): (T extends undefined ? ComplyOptions : NonNullable<T> & ComplyOptions) {
  return withHostedComplianceOptions(options, target) as T extends undefined
    ? ComplyOptions
    : NonNullable<T> & ComplyOptions;
}

export function withHostedStoryboardRunOptions<T extends Partial<StoryboardRunOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
): (T extends undefined ? StoryboardRunOptions : NonNullable<T> & StoryboardRunOptions) {
  const input = (options ?? {}) as Partial<StoryboardRunOptions>;
  const version = resolveHostedComplianceVersion(input.adcpVersion ?? target.version);
  registerHostedComplianceSchemaRoot(version);

  return {
    ...input,
    adcpVersion: version,
    schemaRoot: input.schemaRoot ?? hostedSchemaRootForVersion(version, target),
  } as T extends undefined ? StoryboardRunOptions : NonNullable<T> & StoryboardRunOptions;
}

export function withHostedTestOptions<T extends Partial<TestOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
): (T extends undefined ? TestOptions : NonNullable<T> & TestOptions) {
  const input = (options ?? {}) as Partial<TestOptions>;
  const version = resolveHostedComplianceVersion(input.adcpVersion ?? target.version);
  registerHostedComplianceSchemaRoot(version);

  return {
    ...input,
    adcpVersion: version,
    schemaRoot: input.schemaRoot ?? hostedSchemaRootForVersion(version, target),
  } as T extends undefined ? TestOptions : NonNullable<T> & TestOptions;
}

installHostedStoryboardResolverPatch();
