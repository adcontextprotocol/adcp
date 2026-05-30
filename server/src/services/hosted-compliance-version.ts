import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ComplyOptions,
  ResolveOptions,
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
type RuntimeTestKitAuth = {
  api_key?: string;
  basic?: { username: string; password: string };
  probe_task?: string;
  [key: string]: unknown;
};
type RuntimeTestKit = Omit<NonNullable<TestOptions['test_kit']>, 'auth'> & {
  auth?: RuntimeTestKitAuth;
};
type HostedAuthProbeProfile = {
  tools?: readonly string[];
  supported_protocols?: readonly string[];
};

const DEFAULT_HOSTED_AUTH_PROBE_TASK = 'list_creatives';
const HOSTED_AUTH_PROBE_TASKS_BY_PROTOCOL: Readonly<Record<string, readonly string[]>> = {
  'media-buy': ['list_creatives', 'get_media_buy_delivery'],
  creative: ['list_creatives'],
  signals: ['get_signals'],
  governance: ['list_content_standards', 'list_property_lists', 'list_collection_lists'],
  sponsored_intelligence: ['list_si_sessions'],
  'sponsored-intelligence': ['list_si_sessions'],
  brand: ['list_authorized_properties'],
};
const HOSTED_AUTH_PROBE_TASK_FALLBACKS = [
  'list_creatives',
  'get_media_buy_delivery',
  'get_signals',
  'list_content_standards',
  'list_property_lists',
  'list_collection_lists',
  'list_authorized_properties',
  'list_si_sessions',
] as const;

function repoPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
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

  const line = complianceReleaseLine(target.requested);
  if (!line || target.requested !== line) return [];

  return (SUPPORTED_BADGE_VERSIONS as readonly string[]).includes(line) ? [line] : [];
}

export function agentAdvertisesBadgeEligibleHostedComplianceTarget(
  supportedVersions: readonly string[] | undefined,
  target: HostedComplianceTarget,
): boolean {
  if (!supportedVersions?.length) return false;

  const eligibleVersions = new Set(badgeEligibleVersionsForHostedComplianceTarget(target));
  const [requestedLine] = eligibleVersions;
  if (!requestedLine) {
    return false;
  }

  return supportedVersions.some(version => {
    if (version.includes('-')) return false;
    const line = complianceReleaseLine(version);
    return line === requestedLine;
  });
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

function hostedStableLineAliasForVersion(
  target: HostedComplianceTarget,
  version: string,
): string | undefined {
  if (version !== target.version) return undefined;
  return stableLineForHostedPrereleaseTarget(target);
}

export function hostedComplianceOptions(target: HostedComplianceTarget): HostedResolveOptions {
  assertHostedArtifacts(target.version);
  const hostedStableLineAlias = hostedStableLineAliasForVersion(target, target.version);
  return {
    version: target.version,
    complianceDir: target.complianceDir,
    schemaRoot: target.schemaRoot,
    ...(hostedStableLineAlias && { hostedStableLineAlias }),
  };
}

export function withHostedComplianceOptions<T extends Partial<ResolveOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
): (T extends undefined ? HostedResolveOptions : NonNullable<T> & HostedResolveOptions) {
  const input = (options ?? {}) as Partial<ResolveOptions>;
  const version = resolveHostedComplianceVersion(input.version ?? target.version);
  assertHostedArtifacts(version);
  const hostedStableLineAlias = hostedStableLineAliasForVersion(target, version);

  return {
    ...input,
    version,
    complianceDir: input.complianceDir ?? (version === target.version ? target.complianceDir : hostedComplianceDir(version)),
    schemaRoot: input.schemaRoot ?? hostedSchemaRootForVersion(version, target),
    ...(hostedStableLineAlias && { hostedStableLineAlias }),
  } as T extends undefined ? HostedResolveOptions : NonNullable<T> & HostedResolveOptions;
}

export function hostedAuthProbeTaskForProfile(
  profile: HostedAuthProbeProfile | undefined,
): string {
  const tools = new Set(profile?.tools ?? []);

  for (const protocol of profile?.supported_protocols ?? []) {
    const candidates = HOSTED_AUTH_PROBE_TASKS_BY_PROTOCOL[protocol] ?? [];
    const match = candidates.find(task => tools.has(task));
    if (match) return match;
  }

  return HOSTED_AUTH_PROBE_TASK_FALLBACKS.find(task => tools.has(task)) ?? DEFAULT_HOSTED_AUTH_PROBE_TASK;
}

export function withHostedAuthTestKit<T extends Partial<TestOptions> | undefined>(
  options: T,
  defaultProbeTask = DEFAULT_HOSTED_AUTH_PROBE_TASK,
): (T extends undefined ? TestOptions : NonNullable<T> & TestOptions) {
  const input = (options ?? {}) as Partial<TestOptions>;
  const auth = input.auth;
  const currentKit = (input.test_kit ?? {}) as RuntimeTestKit;
  const currentAuth = currentKit.auth ?? {};
  const nextAuth: RuntimeTestKitAuth = { ...currentAuth };
  let changed = false;

  if (auth?.type === 'bearer' && !nextAuth.api_key) {
    nextAuth.api_key = auth.token;
    changed = true;
  } else if (auth?.type === 'basic' && !nextAuth.basic) {
    nextAuth.basic = { username: auth.username, password: auth.password };
    changed = true;
  }

  const declaresStaticAuth = Boolean(nextAuth.api_key || nextAuth.basic || nextAuth.probe_task);
  if (declaresStaticAuth && !nextAuth.probe_task) {
    nextAuth.probe_task = defaultProbeTask;
    changed = true;
  }

  if (!changed) {
    return input as T extends undefined ? TestOptions : NonNullable<T> & TestOptions;
  }

  return {
    ...input,
    test_kit: {
      ...currentKit,
      auth: nextAuth,
    },
  } as T extends undefined ? TestOptions : NonNullable<T> & TestOptions;
}

export function withHostedComplianceRunOptions<T extends Partial<ComplyOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
  defaultAuthProbeTask?: string,
): (T extends undefined ? ComplyOptions : NonNullable<T> & ComplyOptions) {
  const input = withHostedAuthTestKit(options, defaultAuthProbeTask) as Partial<ComplyOptions>;
  return withHostedComplianceOptions(input, target) as T extends undefined
    ? ComplyOptions
    : NonNullable<T> & ComplyOptions;
}

export function withHostedStoryboardRunOptions<T extends Partial<StoryboardRunOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
  defaultAuthProbeTask?: string,
): (T extends undefined ? StoryboardRunOptions : NonNullable<T> & StoryboardRunOptions) {
  const input = withHostedAuthTestKit(options, defaultAuthProbeTask) as Partial<StoryboardRunOptions>;
  const version = resolveHostedComplianceVersion(input.adcpVersion ?? target.version);
  assertHostedArtifacts(version);
  const hostedStableLineAlias = hostedStableLineAliasForVersion(target, version);

  return {
    ...input,
    adcpVersion: version,
    schemaRoot: input.schemaRoot ?? hostedSchemaRootForVersion(version, target),
    ...(hostedStableLineAlias && { wireAdcpVersion: hostedStableLineAlias }),
  } as T extends undefined ? StoryboardRunOptions : NonNullable<T> & StoryboardRunOptions;
}

export function withHostedTestOptions<T extends Partial<TestOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
  defaultAuthProbeTask?: string,
): (T extends undefined ? TestOptions : NonNullable<T> & TestOptions) {
  const input = withHostedAuthTestKit(options, defaultAuthProbeTask);
  const version = resolveHostedComplianceVersion(input.adcpVersion ?? target.version);
  assertHostedArtifacts(version);
  const hostedStableLineAlias = hostedStableLineAliasForVersion(target, version);

  return {
    ...input,
    adcpVersion: version,
    schemaRoot: input.schemaRoot ?? hostedSchemaRootForVersion(version, target),
    ...(hostedStableLineAlias && { wireAdcpVersion: hostedStableLineAlias }),
  } as T extends undefined ? TestOptions : NonNullable<T> & TestOptions;
}
