/**
 * sync_creatives assignment_operations (assign, unassign, replace) and the
 * 3.3 assignment-scoped trackers and landing-page overrides.
 *
 * Spec: docs/creative/task-reference/sync_creatives.mdx (#assignment-landing-pages,
 * #assignment-trackers, #replacing-a-creative-on-a-package).
 */
import type { CreativeState, MediaBuyState, PackageState, SessionState } from './types.js';
import { isOpenMediaBuy } from './live-creative-updates.js';

type AssignmentRow = Record<string, unknown> & { creative_id: string };

export interface AssignmentOperationError {
  code: string;
  message: string;
  field: string;
  recovery: 'correctable';
}

export interface AssignmentOperationOptions {
  supportsTrackers: boolean;
  supportsLandingPage: boolean;
  /** Creative IDs accepted earlier in the same request. */
  requestCreativeIds: ReadonlySet<string>;
  creativeStatus: (creativeId: string) => string | undefined;
  /** Product-format check for a creative newly placed on a package. */
  validateForPackage: (creativeId: string, pkg: PackageState) => Promise<string | undefined>;
  /** Tracker-slot allocation for the trackers an assignment would carry. */
  validateTrackers?: (creativeId: string, pkg: PackageState, trackers: ReadonlyArray<Record<string, unknown>>) => string | undefined;
}

export interface AssignmentOperationPlan {
  /** Detached copies of every media buy whose assignments change. */
  changedBuys: Map<string, MediaBuyState>;
}


/** Settings a replacement takes over from the assignment it replaces. */
export const TRANSFERRED_ASSIGNMENT_SETTINGS = [
  'weight', 'placement_ids', 'placement_refs', 'rotation_mode', 'group_id', 'sequence_position', 'trackers', 'landing_page_url',
] as const;

function rowsOf(pkg: PackageState): AssignmentRow[] {
  pkg.creativeAssignmentDetails ??= pkg.creativeAssignments.map(creativeId => ({ creative_id: creativeId }));
  return pkg.creativeAssignmentDetails as AssignmentRow[];
}

function syncIds(pkg: PackageState): void {
  pkg.creativeAssignments = rowsOf(pkg).map(row => row.creative_id);
}

function error(code: string, message: string, field: string): AssignmentOperationError {
  return { code, message, field, recovery: 'correctable' };
}

/**
 * Validate and apply operations in order against detached copies of the
 * affected buys. Nothing in the session changes; the caller commits
 * `changedBuys` only when the whole request succeeds.
 */
export async function planAssignmentOperations(
  session: SessionState,
  operations: ReadonlyArray<Record<string, unknown>>,
  options: AssignmentOperationOptions,
): Promise<{ errors: AssignmentOperationError[] } | AssignmentOperationPlan> {
  const working = new Map<string, MediaBuyState>();
  const changed = new Set<string>();

  const locate = (packageId: string): { mb: MediaBuyState; pkg: PackageState } | 'missing' | 'ambiguous' => {
    // Only open packages take assignment changes. Training package IDs repeat
    // across buys (pkg-0), so finished buys must not make a live one ambiguous.
    const matches: MediaBuyState[] = [];
    for (const mb of session.mediaBuys.values()) {
      if (!isOpenMediaBuy(mb)) continue;
      if (mb.packages.some(p => p.packageId === packageId && !p.canceled)) matches.push(mb);
    }
    if (matches.length === 0) return 'missing';
    if (matches.length > 1) return 'ambiguous';
    const id = matches[0].mediaBuyId;
    if (!working.has(id)) working.set(id, structuredClone(matches[0]));
    const mb = working.get(id)!;
    return { mb, pkg: mb.packages.find(p => p.packageId === packageId && !p.canceled)! };
  };
  const creativeKnown = (creativeId: string) =>
    options.requestCreativeIds.has(creativeId) || options.creativeStatus(creativeId) !== undefined;

  for (const [index, op] of operations.entries()) {
    const at = `assignment_operations[${index}]`;
    const kind = op.operation;
    const creativeId = op.creative_id as string;
    const packageId = op.package_id as string;

    if (kind === 'merge') {
      return { errors: [error('UNSUPPORTED_FEATURE', 'This seller does not declare creative.supports_assignment_merge.', `${at}.operation`)] };
    }
    if (kind === 'assign' && op.trackers !== undefined && !options.supportsTrackers) {
      return { errors: [error('UNSUPPORTED_FEATURE', 'Assignment trackers require creative.supports_assignment_trackers.', `${at}.trackers`)] };
    }
    if (kind === 'assign' && op.landing_page_url !== undefined && !options.supportsLandingPage) {
      return { errors: [error('UNSUPPORTED_FEATURE', 'Assignment landing pages require creative.supports_assignment_landing_page.', `${at}.landing_page_url`)] };
    }

    const located = locate(packageId);
    if (located === 'missing') {
      return { errors: [error('PACKAGE_NOT_FOUND', `Package not found: ${packageId}`, `${at}.package_id`)] };
    }
    if (located === 'ambiguous') {
      return { errors: [error('VALIDATION_ERROR', `Package ID ${packageId} matches more than one media buy in this account.`, `${at}.package_id`)] };
    }
    const { mb, pkg } = located;
    if (!creativeKnown(creativeId)) {
      return { errors: [error('CREATIVE_NOT_FOUND', `Creative not found: ${creativeId}`, `${at}.creative_id`)] };
    }
    const rows = rowsOf(pkg);
    const existing = rows.findIndex(row => row.creative_id === creativeId);

    // Review status alone never blocks an assignment: a pending_review or
    // rejected creative may be assigned, and only package-approved ones serve.
    const placeable = async (): Promise<AssignmentOperationError | undefined> => {
      const violation = await options.validateForPackage(creativeId, pkg);
      return violation ? error('VALIDATION_ERROR', violation, `${at}.creative_id`) : undefined;
    };

    if (kind === 'assign') {
      const settings = Object.fromEntries(
        ['weight', 'placement_ids', 'trackers', 'landing_page_url']
          .filter(key => op[key] !== undefined)
          .map(key => [key, structuredClone(op[key])]),
      );
      const trackersAfter = (settings.trackers ?? (existing >= 0 ? rows[existing].trackers : undefined)) as
        ReadonlyArray<Record<string, unknown>> | undefined;
      const slotProblem = settings.trackers !== undefined || existing < 0
        ? trackersAfter && options.validateTrackers?.(creativeId, pkg, trackersAfter)
        : undefined;
      if (slotProblem) return { errors: [error('VALIDATION_ERROR', slotProblem, `${at}.trackers`)] };
      if (existing >= 0) {
        const before = JSON.stringify(rows[existing]);
        rows[existing] = { ...rows[existing], ...settings };
        if (JSON.stringify(rows[existing]) !== before) changed.add(mb.mediaBuyId);
      } else {
        const problem = await placeable();
        if (problem) return { errors: [problem] };
        rows.push({ creative_id: creativeId, ...settings });
        changed.add(mb.mediaBuyId);
      }
    } else if (kind === 'unassign') {
      if (existing >= 0) {
        rows.splice(existing, 1);
        changed.add(mb.mediaBuyId);
      }
    } else if (kind === 'replace') {
      const replacedId = op.replaces_creative_id as string;
      const replacedIndex = rows.findIndex(row => row.creative_id === replacedId);
      if (replacedIndex < 0) {
        return { errors: [error('INVALID_STATE', `Creative ${replacedId} is not assigned to package ${packageId}.`, `${at}.replaces_creative_id`)] };
      }
      if (existing >= 0 && replacedId !== creativeId) {
        return { errors: [error('INVALID_STATE', `Creative ${creativeId} is already assigned to package ${packageId}; unassign it or replace a different creative.`, `${at}.creative_id`)] };
      }
      const problem = await placeable();
      if (problem) return { errors: [problem] };
      // The replacement takes over every authored setting; supplied weight
      // replaces the weight, supplied placement_ids replaces all routing.
      const transferred: AssignmentRow = { ...structuredClone(rows[replacedIndex]), creative_id: creativeId };
      if (op.weight !== undefined) transferred.weight = op.weight;
      if (op.placement_ids !== undefined) {
        transferred.placement_ids = structuredClone(op.placement_ids);
        delete transferred.placement_refs;
      }
      // Transferred trackers must fit the replacement's own tracker occupancy.
      const transferredTrackers = transferred.trackers as ReadonlyArray<Record<string, unknown>> | undefined;
      const slotProblem = transferredTrackers && options.validateTrackers?.(creativeId, pkg, transferredTrackers);
      if (slotProblem) return { errors: [error('VALIDATION_ERROR', slotProblem, `${at}.creative_id`)] };
      if (replacedId === creativeId) {
        // Replacing a creative with itself only applies supplied overrides.
        if (JSON.stringify(transferred) !== JSON.stringify(rows[replacedIndex])) {
          rows[replacedIndex] = transferred;
          changed.add(mb.mediaBuyId);
        }
      } else {
        rows[replacedIndex] = transferred;
        changed.add(mb.mediaBuyId);
      }
    } else {
      return { errors: [error('VALIDATION_ERROR', `Unknown assignment operation: ${String(kind)}`, `${at}.operation`)] };
    }
    syncIds(pkg);
  }

  return { changedBuys: new Map([...changed].map(id => [id, working.get(id)!])) };
}

/** Commit a plan: one revision and history entry per changed buy. */
export function commitAssignmentPlan(session: SessionState, plan: AssignmentOperationPlan, now: string): void {
  for (const [id, mb] of plan.changedBuys) {
    mb.revision += 1;
    mb.updatedAt = now;
    mb.history.push({
      revision: mb.revision,
      timestamp: now,
      actor: 'buyer',
      action: 'creative_assignments_updated',
      summary: 'Package creative assignments changed through sync_creatives assignment_operations.',
    });
    session.mediaBuys.set(id, mb);
  }
}

function uniqueClickThrough(creative: CreativeState | undefined): string | undefined {
  const assets = (creative?.assets ?? creative?.manifest?.assets ?? {}) as Record<string, unknown>;
  const urls = Object.values(assets)
    .flatMap(value => (Array.isArray(value) ? value : [value]))
    .filter((asset): asset is Record<string, unknown> =>
      !!asset && typeof asset === 'object' && (asset as Record<string, unknown>).asset_type === 'url'
      && (asset as Record<string, unknown>).url_type === 'clickthrough')
    .map(asset => asset.url as string);
  const distinct = [...new Set(urls)];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/** Assignment-scoped readback fields for a declaring seller. */
export function assignmentReadbackFields(
  row: Record<string, unknown> | undefined,
  creative: CreativeState | undefined,
  options: { supportsTrackers: boolean; supportsLandingPage: boolean },
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (options.supportsTrackers) {
    fields.trackers = Array.isArray(row?.trackers) ? structuredClone(row!.trackers) : [];
  }
  if (options.supportsLandingPage) {
    const effective = typeof row?.landing_page_url === 'string' ? row.landing_page_url : uniqueClickThrough(creative);
    if (effective) fields.landing_page_url = effective;
  }
  return fields;
}

export function assignmentRow(pkg: PackageState, creativeId: string): Record<string, unknown> | undefined {
  return (pkg.creativeAssignmentDetails as AssignmentRow[] | undefined)?.find(row => row.creative_id === creativeId);
}

export interface TrackerSlot {
  asset_group_id: string;
  asset_type: string;
  max?: number;
}

/** Which assignment-tracker events each canonical tracker slot accepts. A
 * pixel_tracker slot outside this table accepts any event. */
const TRACKER_SLOT_EVENTS: Record<string, (event: string) => boolean> = {
  impression_tracker: event => event === 'impression',
  click_tracker: event => event === 'click',
  viewability_tracker: event => event.startsWith('viewable_') || event === 'audible_video_complete',
};

export function isTrackerSlot(slot: TrackerSlot): boolean {
  return slot.asset_type === 'pixel_tracker' || slot.asset_group_id in TRACKER_SLOT_EVENTS;
}

/**
 * Allocate assignment trackers to the format's declared tracker slots, after
 * the creative's own tracker assets (`occupancy`) keep theirs. Each tracker
 * takes one occurrence of a compatible slot; event-specific slots are tried
 * before generic ones. Returns a reason when no valid allocation exists.
 * A format that declares no tracker slot makes no slot claim (the canonical
 * image tracking model fires trackers through macros), so nothing is refused.
 */
export function trackerAllocationProblem(
  slots: ReadonlyArray<TrackerSlot>,
  occupancy: Readonly<Record<string, number>>,
  trackers: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  const trackerSlots = slots.filter(isTrackerSlot);
  if (trackerSlots.length === 0) return undefined;
  const remaining = new Map(trackerSlots.map(slot => [
    slot.asset_group_id,
    slot.max === undefined ? Number.POSITIVE_INFINITY : slot.max - (occupancy[slot.asset_group_id] ?? 0),
  ]));
  const ordered = [...trackerSlots].sort((a, b) =>
    Number(b.asset_group_id in TRACKER_SLOT_EVENTS) - Number(a.asset_group_id in TRACKER_SLOT_EVENTS));
  for (const tracker of trackers) {
    const event = String(tracker.event === 'custom' ? 'custom' : tracker.event);
    const slot = ordered.find(candidate => {
      const accepts = TRACKER_SLOT_EVENTS[candidate.asset_group_id];
      return (accepts ? accepts(event) : true) && (remaining.get(candidate.asset_group_id) ?? 0) > 0;
    });
    if (!slot) {
      return `No declared tracker slot has room for a ${event} tracker; the format's tracker slots are full or none accepts this event.`;
    }
    remaining.set(slot.asset_group_id, (remaining.get(slot.asset_group_id) ?? 0) - 1);
  }
  return undefined;
}
