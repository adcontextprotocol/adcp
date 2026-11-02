/**
 * Live creative updates (experimental, 3.3): which changes the training
 * seller applies in place to a creative that is serving, and how.
 *
 * Spec: docs/creative/task-reference/sync_creatives.mdx#live-creative-updates
 */
import { isDeepStrictEqual } from 'node:util';
import type { CreativeState, SessionState } from './types.js';

export type CreativeChangeKind = 'click_through' | 'trackers' | 'asset_content' | 'format';
export type LiveUpdateServingMode = 'uninterrupted' | 'staged' | 'paused_for_review';

export interface LiveUpdatePolicyEntry {
  change: CreativeChangeKind;
  serving: LiveUpdateServingMode;
  on_rejection?: 'keeps_prior' | 'stops';
}

/**
 * The training seller's declaration. It behaves like an ad server that edits
 * click-throughs and trackers on a trafficked creative immediately, traffics
 * replacement content beside the serving version until review approves it,
 * and cannot change a trafficked creative's format.
 */
export const TRAINING_LIVE_UPDATE_POLICY: readonly LiveUpdatePolicyEntry[] = [
  { change: 'click_through', serving: 'uninterrupted' },
  { change: 'trackers', serving: 'uninterrupted' },
  { change: 'asset_content', serving: 'staged', on_rejection: 'keeps_prior' },
];

export const TRAINING_LIVE_UPDATE_MAX_PROPAGATION_SECONDS = 0;

export function liveUpdatesCapability(): Record<string, unknown> {
  return {
    in_place: TRAINING_LIVE_UPDATE_POLICY.map(entry => ({ ...entry })),
    max_propagation_seconds: TRAINING_LIVE_UPDATE_MAX_PROPAGATION_SECONDS,
  };
}

/** Content the seller holds for a staged update until it promotes it. */
export interface StagedCreativeContent {
  formatId?: CreativeState['formatId'];
  formatKind?: CreativeState['formatKind'];
  formatOptionRef?: CreativeState['formatOptionRef'];
  assets?: CreativeState['assets'];
  componentAssets?: CreativeState['componentAssets'];
  localization?: CreativeState['localization'];
  manifest?: CreativeState['manifest'];
}

export interface StagedCreativeUpdate {
  status: 'pending_review' | 'rejected';
  changeKinds: CreativeChangeKind[];
  stagedAt: string;
  rejectionReason?: string;
  content: StagedCreativeContent;
}

const TERMINAL_MEDIA_BUY_STATUSES = new Set(['completed', 'rejected', 'canceled']);
const KIND_ORDER: readonly CreativeChangeKind[] = ['click_through', 'trackers', 'asset_content', 'format'];
const MODE_ORDER: readonly LiveUpdateServingMode[] = ['uninterrupted', 'staged', 'paused_for_review'];
const TRACKER_ASSET_TYPES = new Set(['pixel_tracker', 'vast_tracker', 'daast_tracker']);

/**
 * Packages on which the creative is live: assigned, not canceled, flight not
 * ended, and on a media buy that is not terminal. Paused packages count. The
 * session is already scoped to the caller's account.
 */
export function livePackageIds(
  session: SessionState,
  creativeId: string,
  now: Date = new Date(),
): string[] {
  const ids: string[] = [];
  for (const mediaBuy of session.mediaBuys.values()) {
    if (TERMINAL_MEDIA_BUY_STATUSES.has(mediaBuy.status)) continue;
    for (const pkg of mediaBuy.packages) {
      if (pkg.canceled) continue;
      if (!pkg.creativeAssignments.includes(creativeId)) continue;
      const end = Date.parse(pkg.endTime);
      if (Number.isFinite(end) && end <= now.getTime()) continue;
      ids.push(pkg.packageId);
    }
  }
  return ids;
}

function assetKinds(value: unknown): CreativeChangeKind[] {
  if (Array.isArray(value)) return value.flatMap(assetKinds);
  if (!value || typeof value !== 'object') return ['asset_content'];
  const asset = value as Record<string, unknown>;
  if (asset.asset_type === 'url') {
    if (asset.url_type === 'clickthrough') return ['click_through'];
    if (asset.url_type === 'tracker_pixel' || asset.url_type === 'tracker_script') return ['trackers'];
    return ['asset_content'];
  }
  if (typeof asset.asset_type === 'string' && TRACKER_ASSET_TYPES.has(asset.asset_type)) return ['trackers'];
  return ['asset_content'];
}

/**
 * Classify a sync item against the version that serves. Name, tags and the
 * other fields outside canonical revision content are not a change kind.
 */
export function classifyCreativeChange(
  serving: StagedCreativeContent,
  next: StagedCreativeContent,
  formatChanged: boolean,
): CreativeChangeKind[] {
  const kinds = new Set<CreativeChangeKind>();
  if (formatChanged) kinds.add('format');
  const before = (serving.assets ?? {}) as Record<string, unknown>;
  const after = (next.assets ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    // Added, removed, and changed slots all count, by the asset on each side.
    for (const side of [before[key], after[key]]) {
      if (side === undefined) continue;
      for (const kind of assetKinds(side)) kinds.add(kind);
    }
  }
  if (!isDeepStrictEqual(serving.componentAssets ?? undefined, next.componentAssets ?? undefined)) kinds.add('asset_content');
  if (!isDeepStrictEqual(serving.localization ?? undefined, next.localization ?? undefined)) kinds.add('asset_content');
  const servingSelection = (serving.manifest as { representation_selection?: unknown } | undefined)?.representation_selection;
  const nextSelection = (next.manifest as { representation_selection?: unknown } | undefined)?.representation_selection;
  if (!isDeepStrictEqual(servingSelection, nextSelection)) kinds.add('asset_content');
  return KIND_ORDER.filter(kind => kinds.has(kind));
}

export type LiveUpdateDecision =
  | { outcome: 'apply'; mode: LiveUpdateServingMode | null }
  | { outcome: 'refuse'; refusedChanges: CreativeChangeKind[] };

/** The most disruptive declared mode applies; any undeclared kind refuses the item. */
export function decideLiveUpdate(kinds: CreativeChangeKind[]): LiveUpdateDecision {
  if (kinds.length === 0) return { outcome: 'apply', mode: null };
  const refused = kinds.filter(kind => !TRAINING_LIVE_UPDATE_POLICY.some(entry => entry.change === kind));
  if (refused.length > 0) return { outcome: 'refuse', refusedChanges: refused };
  let mode: LiveUpdateServingMode = 'uninterrupted';
  for (const kind of kinds) {
    const entry = TRAINING_LIVE_UPDATE_POLICY.find(e => e.change === kind)!;
    if (MODE_ORDER.indexOf(entry.serving) > MODE_ORDER.indexOf(mode)) mode = entry.serving;
  }
  return { outcome: 'apply', mode };
}

export function stagedOnRejection(): 'keeps_prior' | 'stops' {
  return TRAINING_LIVE_UPDATE_POLICY.find(e => e.serving === 'staged')?.on_rejection ?? 'keeps_prior';
}

export function stagedUpdateWire(staged: StagedCreativeUpdate): Record<string, unknown> {
  return {
    status: staged.status,
    change_kinds: [...staged.changeKinds],
    staged_at: staged.stagedAt,
    ...(staged.status === 'rejected' && { rejection_reason: staged.rejectionReason ?? 'Rejected in review.' }),
  };
}

/** Promote a staged update: its content becomes the serving version. */
export function promoteStagedUpdate(creative: CreativeState): void {
  const staged = creative.stagedUpdate;
  if (!staged) return;
  const { content } = staged;
  delete creative.formatId;
  delete creative.formatKind;
  delete creative.formatOptionRef;
  delete creative.assets;
  delete creative.componentAssets;
  delete creative.localization;
  delete creative.manifest;
  Object.assign(creative, Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined)));
  delete creative.stagedUpdate;
  creative.syncedAt = new Date().toISOString();
}

export function servingContent(creative: CreativeState): StagedCreativeContent {
  return {
    formatId: creative.formatId,
    formatKind: creative.formatKind,
    formatOptionRef: creative.formatOptionRef,
    // Controller-seeded creatives carry their assets only on the manifest.
    assets: creative.assets ?? creative.manifest?.assets,
    componentAssets: creative.componentAssets ?? creative.manifest?.component_assets,
    localization: creative.localization,
    manifest: creative.manifest,
  };
}
