import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ComplyOptions,
  ResolveOptions,
  StoryboardRunOptions,
  TestOptions,
} from '@adcp/sdk/testing';
import { isComplianceVersionSupported } from '@adcp/sdk/testing';
import { SUPPORTED_BADGE_VERSIONS } from './adcp-taxonomy.js';

export const DEFAULT_HOSTED_COMPLIANCE_LINE = '3.0';
export const HOSTED_COMPLIANCE_TARGET_PREFERENCE = [
  '3.1',
  '3.1-rc',
  '3.1-beta',
  DEFAULT_HOSTED_COMPLIANCE_LINE,
] as const;
// Budget for a full-suite comply() assessment. @adcp/sdk 9.0.0-beta.28 applies
// this value as the wall-clock budget for the *entire* pre-flight assessment
// (not per-call), and a capability-rich agent legitimately runs ~117s — the SDK
// default (120s) grades such agents "unreachable" with 0 steps. 600s clears
// that ceiling. Revisit when the SDK restores per-call timeout semantics
// (adcontextprotocol/adcp-client#2221): a per-call ceiling this large would let
// a single hung call hold a connection for 10 minutes.
export const HOSTED_FULL_COMPLIANCE_TIMEOUT_MS = 600_000;

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
type HostedComplianceProfile = {
  adcp_supported_versions?: readonly string[];
};

const DEFAULT_HOSTED_AUTH_PROBE_TASK = 'list_creatives';
const HOSTED_AUTH_PROBE_TASKS_BY_PROTOCOL: Readonly<Record<string, readonly string[]>> = {
  media_buy: ['list_creatives', 'get_media_buy_delivery'],
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
const HOSTED_STATIC_API_KEY_BY_PROTOCOL: ReadonlyArray<{
  protocols: readonly string[];
  apiKey: string;
}> = [
  {
    protocols: ['media_buy', 'media-buy', 'creative', 'governance'],
    apiKey: 'demo-acme-outdoor-v1',
  },
  {
    protocols: ['signals', 'brand', 'sponsored_intelligence', 'sponsored-intelligence'],
    apiKey: 'demo-nova-motors-v1',
  },
];

function repoPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionSortKey(version: string): number[] {
  const match = version.match(/^([1-9][0-9]*)\.([0-9]+)\.([0-9]+)(?:-(beta|rc)\.([0-9]+))?$/);
  if (!match) return [0, 0, 0, -1, -1];

  const [, major, minor, patch, prereleaseLabel, prereleaseNumber] = match;
  const prereleaseRank = prereleaseLabel === 'beta'
    ? 0
    : prereleaseLabel === 'rc'
      ? 1
      : Number.MAX_SAFE_INTEGER;
  return [
    Number.parseInt(major, 10),
    Number.parseInt(minor, 10),
    Number.parseInt(patch, 10),
    prereleaseRank,
    prereleaseNumber === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(prereleaseNumber, 10),
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
  if (target.requested.includes('-')) return undefined;

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

function latestPrereleaseComplianceVersionForLine(line: string, label: 'beta' | 'rc'): string {
  const complianceRoot = repoPath('dist', 'compliance');
  const prereleaseRe = new RegExp(`^${escapeRegex(line)}\\.0-${label}\\.\\d+$`);
  const versions = complianceVersions()
    .filter(name => prereleaseRe.test(name))
    .sort(compareVersions);

  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(
      `No checked-in AdCP ${line}-${label} compliance cache found at ${complianceRoot}. Run npm run build:compliance.`,
    );
  }
  return latest;
}

function latestBetaComplianceVersionForLine(line: string): string {
  return latestPrereleaseComplianceVersionForLine(line, 'beta');
}

function latestRcComplianceVersionForLine(line: string): string {
  return latestPrereleaseComplianceVersionForLine(line, 'rc');
}

function latestBadgeEligibleComplianceVersionForLine(line: string): string {
  try {
    return latestStableComplianceVersionForLine(line);
  } catch (stableError) {
    try {
      return latestRcComplianceVersionForLine(line);
    } catch {
      // Fall through to beta/default handling below.
    }

    if (line === DEFAULT_HOSTED_COMPLIANCE_LINE) {
      // The default line may temporarily fall back to a beta cache while its
      // stable compliance bundle is being staged.
      return latestBetaComplianceVersionForLine(line);
    }

    throw stableError;
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
  const rcMatch = target.match(/^([1-9][0-9]*\.[0-9]+)-rc$/);
  if (rcMatch) {
    return latestRcComplianceVersionForLine(rcMatch[1]);
  }
  const wirePrereleaseMatch = target.match(/^([1-9][0-9]*\.[0-9]+)-(beta|rc)\.([0-9]+)$/);
  if (wirePrereleaseMatch) {
    return `${wirePrereleaseMatch[1]}.0-${wirePrereleaseMatch[2]}.${wirePrereleaseMatch[3]}`;
  }
  if (/^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:-(?:beta|rc)\.[0-9]+)?$/.test(target)) {
    return target;
  }
  throw new Error(
    `Unsupported AdCP compliance target "${target}". Use a line alias like 3.0, a prerelease alias like 3.1-rc or 3.1-beta, or an exact bundled version like 3.0.12.`,
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
  if (target.requested.includes('-') || target.version.includes('-')) {
    return [];
  }

  const line = complianceReleaseLine(target.requested);
  if (!line || target.requested !== line) return [];

  return (SUPPORTED_BADGE_VERSIONS as readonly string[]).includes(line) ? [line] : [];
}

export function hostedComplianceTargetPreference(): HostedComplianceTarget[] {
  return HOSTED_COMPLIANCE_TARGET_PREFERENCE.flatMap(requested => {
    try {
      return [hostedComplianceTarget(requested)];
    } catch {
      return [];
    }
  });
}

function hostedComplianceTargetForBundledVersion(version: string): HostedComplianceTarget {
  const stableLine = complianceReleaseLine(version);
  if (stableLine === DEFAULT_HOSTED_COMPLIANCE_LINE && !version.includes('-')) {
    return hostedComplianceTarget(DEFAULT_HOSTED_COMPLIANCE_LINE);
  }

  const prerelease = version.match(/^([1-9][0-9]*\.[0-9]+)\.0-(beta|rc)\.([0-9]+)$/);
  if (prerelease) {
    return hostedComplianceTarget(`${prerelease[1]}-${prerelease[2]}.${prerelease[3]}`);
  }

  return hostedComplianceTarget(version);
}

function hostedComplianceTargetCandidates(): HostedComplianceTarget[] {
  const byRequested = new Map<string, HostedComplianceTarget>();

  function add(target: HostedComplianceTarget) {
    if (!byRequested.has(target.requested)) {
      byRequested.set(target.requested, target);
    }
  }

  function addRequested(requested: string) {
    try {
      add(hostedComplianceTarget(requested));
    } catch {
      // Optional prerelease aliases may be absent on older release branches.
    }
  }

  const bundledVersions = complianceVersions().sort(compareVersions).reverse();
  addRequested('3.1');
  addRequested('3.1-rc');
  for (const version of bundledVersions.filter(v => /^3\.1\.0-rc\.\d+$/.test(v))) {
    add(hostedComplianceTargetForBundledVersion(version));
  }
  addRequested('3.1-beta');
  for (const version of bundledVersions.filter(v => /^3\.1\.0-beta\.\d+$/.test(v))) {
    add(hostedComplianceTargetForBundledVersion(version));
  }
  addRequested(DEFAULT_HOSTED_COMPLIANCE_LINE);

  for (const version of bundledVersions) {
    if (version === 'latest') continue;
    const target = hostedComplianceTargetForBundledVersion(version);
    add(target);
  }
  return [...byRequested.values()];
}

export function selectHostedComplianceTargetForSupportedVersions(
  supportedVersions: readonly string[] | undefined,
  fallback: HostedComplianceTarget = hostedComplianceTarget(),
): HostedComplianceTarget {
  if (!supportedVersions?.length) return fallback;

  for (const target of hostedComplianceTargetCandidates()) {
    if (agentAdvertisesHostedComplianceTarget(supportedVersions, target)) {
      return target;
    }
  }

  return fallback;
}

export function selectCanonicalHostedComplianceTargetForSupportedVersions(
  supportedVersions: readonly string[] | undefined,
  fallback: HostedComplianceTarget = hostedComplianceTarget(),
): HostedComplianceTarget {
  if (!supportedVersions?.length) return fallback;

  for (const line of SUPPORTED_BADGE_VERSIONS) {
    try {
      const stableTarget = hostedComplianceTarget(line);
      const hostedStableLineAlias = hostedStableLineAliasForVersion(stableTarget, stableTarget.version);
      if (isComplianceVersionSupported(stableTarget.version, supportedVersions, { hostedStableLineAlias })) {
        return stableTarget;
      }
    } catch {
      // A badge line may be configured before its compliance artifacts are
      // present on a release branch. Skip it and keep looking for a usable
      // public target.
    }
  }

  return selectHostedComplianceTargetForSupportedVersions(supportedVersions, fallback);
}

export function selectHostedComplianceTargetForProfile(
  profile: HostedComplianceProfile | undefined,
  fallback: HostedComplianceTarget = hostedComplianceTarget(),
): HostedComplianceTarget {
  return selectHostedComplianceTargetForSupportedVersions(profile?.adcp_supported_versions, fallback);
}

export function selectCanonicalHostedComplianceTargetForProfile(
  profile: HostedComplianceProfile | undefined,
  fallback: HostedComplianceTarget = hostedComplianceTarget(),
): HostedComplianceTarget {
  return selectCanonicalHostedComplianceTargetForSupportedVersions(profile?.adcp_supported_versions, fallback);
}

export function agentAdvertisesHostedComplianceTarget(
  supportedVersions: readonly string[] | undefined,
  target: HostedComplianceTarget,
): boolean {
  if (!supportedVersions?.length) return false;

  const stableLine = stableLineForHostedPrereleaseTarget(target);
  if (stableLine) {
    return isComplianceVersionSupported(stableLine, supportedVersions);
  }

  const hostedStableLineAlias = hostedStableLineAliasForVersion(target, target.version);
  return isComplianceVersionSupported(target.version, supportedVersions, { hostedStableLineAlias });
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

export function hostedStaticApiKeyForProfile(
  profile: HostedAuthProbeProfile | undefined,
): string | undefined {
  const protocols = new Set(profile?.supported_protocols ?? []);
  for (const entry of HOSTED_STATIC_API_KEY_BY_PROTOCOL) {
    if (entry.protocols.some(protocol => protocols.has(protocol))) {
      return entry.apiKey;
    }
  }
  return undefined;
}

export function withHostedAuthTestKit<T extends Partial<TestOptions> | undefined>(
  options: T,
  defaultProbeTask = DEFAULT_HOSTED_AUTH_PROBE_TASK,
  defaultApiKey?: string,
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
  } else if (defaultApiKey && !nextAuth.api_key && !nextAuth.basic) {
    nextAuth.api_key = defaultApiKey;
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
  defaultApiKey?: string,
): (T extends undefined ? ComplyOptions : NonNullable<T> & ComplyOptions) {
  const input = withHostedAuthTestKit(options, defaultAuthProbeTask, defaultApiKey) as Partial<ComplyOptions>;
  return withHostedComplianceOptions(input, target) as T extends undefined
    ? ComplyOptions
    : NonNullable<T> & ComplyOptions;
}

export function withHostedStoryboardRunOptions<T extends Partial<StoryboardRunOptions> | undefined>(
  options: T,
  target: HostedComplianceTarget,
  defaultAuthProbeTask?: string,
  defaultApiKey?: string,
): (T extends undefined ? StoryboardRunOptions : NonNullable<T> & StoryboardRunOptions) {
  const input = withHostedAuthTestKit(options, defaultAuthProbeTask, defaultApiKey) as Partial<StoryboardRunOptions>;
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
  defaultApiKey?: string,
): (T extends undefined ? TestOptions : NonNullable<T> & TestOptions) {
  const input = withHostedAuthTestKit(options, defaultAuthProbeTask, defaultApiKey);
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
