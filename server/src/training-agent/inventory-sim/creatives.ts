/**
 * The creative library of an inventory tenant: creatives a caller syncs or
 * uploads inline on a package, and their assignments to the packages it has
 * bought. It lives in the caller's market document (`market-store.ts`), so a
 * creative is visible only to the account that synced it.
 *
 * Formats are keyed by their canonical format_option_id from the seed's
 * product format declarations; the named-format wire is translated in
 * `creative-wire.ts`. A creative may only be assigned to a package whose
 * product serves its format. Every creative is approved on arrival, and
 * delivery does not wait for one.
 */
import type { MarketDocument, MediaBuyRecord, PackageRecord } from './market-store.js';

export interface CreativeRecord {
  creative_id: string;
  account_id: string;
  name: string;
  format_option_id: string;
  assets: Record<string, unknown>;
  created_date: string;
  updated_date: string;
}

export interface AssignmentRecord {
  creative_id: string;
  weight?: number;
  assigned_date: string;
}

export interface CreativeError {
  code: string;
  message: string;
  field?: string;
}

/** What the library needs to know about the tenant's seed: format_option_ids,
 * and the wire translation for them (`creative-wire.ts`). */
export interface CreativeCatalog {
  /** Every format the seed serves. */
  formats: ReadonlySet<string>;
  /** The formats a product's placements serve. */
  productFormats(productId: string): ReadonlySet<string>;
  /** A format's name for messages. */
  label(formatOptionId: string): string;
  /** The format a creative on the wire carries, optionally limited to some. */
  resolve(input: Record<string, unknown>, field: string, allowed?: ReadonlySet<string>): { formatOptionId: string } | { error: CreativeError };
  /** The wire fields that name a format when a creative is listed. */
  wire(formatOptionId: string): Record<string, unknown>;
  /** The formats a list_creatives filter names, if it names any. */
  filter(filters: Record<string, unknown>): ReadonlySet<string> | undefined;
}

/** Keep the caller's session document small: creatives carry asset
 * references, not media. */
export const MAX_CREATIVES_PER_ACCOUNT = 200;
export const MAX_CREATIVE_BYTES = 32 * 1024;
const MAX_CREATIVES_PER_REQUEST = 100;
/** Assignment fields this seller does not support, so it rejects them rather
 * than dropping them. */
const UNSUPPORTED_ASSIGNMENT_FIELDS = ['trackers', 'landing_page_url', 'installment_refs', 'placement_ids', 'placement_refs'];

export class CreativeRequestError extends Error {
  constructor(readonly errors: CreativeError[]) {
    super(errors.map(error => error.message).join('; '));
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type CreativeContent = Pick<CreativeRecord, 'creative_id' | 'name' | 'format_option_id' | 'assets'>;

function sameContent(a: CreativeRecord, b: CreativeContent): boolean {
  return a.name === b.name && a.format_option_id === b.format_option_id && JSON.stringify(a.assets) === JSON.stringify(b.assets);
}

/** Check one creative from sync_creatives or a package's inline creatives.
 * `allowed` limits the formats it may be in. */
export function parseCreative(input: unknown, field: string, catalog: CreativeCatalog, allowed?: ReadonlySet<string>): { creative: CreativeContent } | { error: CreativeError } {
  if (!isObject(input)) return { error: { code: 'INVALID_REQUEST', message: 'Each creative must be an object', field } };
  const id = input.creative_id;
  if (typeof id !== 'string' || id.length === 0) return { error: { code: 'INVALID_REQUEST', message: 'creative_id is required', field: `${field}.creative_id` } };
  if (typeof input.name !== 'string' || input.name.length === 0) return { error: { code: 'INVALID_REQUEST', message: `Creative ${id} needs a name`, field: `${field}.name` } };
  if (!isObject(input.assets)) return { error: { code: 'INVALID_REQUEST', message: `Creative ${id} needs assets`, field: `${field}.assets` } };
  if (input.localization !== undefined) {
    return { error: { code: 'UNSUPPORTED_FEATURE', message: 'This seller does not localize creatives', field: `${field}.localization` } };
  }
  const format = catalog.resolve(input, field, allowed);
  if ('error' in format) return format;
  if (JSON.stringify(input).length > MAX_CREATIVE_BYTES) {
    return { error: { code: 'INVALID_REQUEST', message: `Creative ${id} is over ${MAX_CREATIVE_BYTES} bytes; reference hosted media by URL`, field } };
  }
  return {
    creative: {
      creative_id: id,
      name: input.name,
      format_option_id: format.formatOptionId,
      assets: input.assets,
    },
  };
}

/** The packages an account has bought, by id. */
function accountPackages(doc: MarketDocument, accountId: string): Map<string, { buy: MediaBuyRecord; pkg: PackageRecord }> {
  const packages = new Map<string, { buy: MediaBuyRecord; pkg: PackageRecord }>();
  for (const buy of doc.media_buys) {
    if (buy.account_id !== accountId) continue;
    for (const pkg of buy.packages) packages.set(pkg.package_id, { buy, pkg });
  }
  return packages;
}

export function libraryOf(doc: MarketDocument): CreativeRecord[] {
  doc.creatives ??= [];
  return doc.creatives;
}

export function findCreative(doc: MarketDocument, accountId: string, creativeId: string): CreativeRecord | undefined {
  return libraryOf(doc).find(creative => creative.account_id === accountId && creative.creative_id === creativeId);
}

/** Add or update a creative in the account's library. */
export function upsertCreative(doc: MarketDocument, accountId: string, parsed: CreativeContent, nowIso: string): 'created' | 'updated' | 'unchanged' {
  const existing = findCreative(doc, accountId, parsed.creative_id);
  if (existing) {
    if (sameContent(existing, parsed)) return 'unchanged';
    Object.assign(existing, parsed, { updated_date: nowIso });
    return 'updated';
  }
  if (libraryOf(doc).filter(creative => creative.account_id === accountId).length >= MAX_CREATIVES_PER_ACCOUNT) {
    throw new CreativeRequestError([{ code: 'INVALID_REQUEST', message: `The sandbox keeps at most ${MAX_CREATIVES_PER_ACCOUNT} creatives per account` }]);
  }
  libraryOf(doc).push({ ...parsed, account_id: accountId, created_date: nowIso, updated_date: nowIso });
  return 'created';
}

/** Whether a creative may be assigned to a package: both exist, the package
 * is live, and its product serves the creative's format. */
export function assignmentError(doc: MarketDocument, accountId: string, catalog: CreativeCatalog, creativeId: string, pkg: PackageRecord | undefined, packageId: string, field: string): CreativeError | undefined {
  const creative = findCreative(doc, accountId, creativeId);
  if (!creative) return { code: 'CREATIVE_NOT_FOUND', message: `Unknown creative ${creativeId}`, field };
  if (!pkg) return { code: 'PACKAGE_NOT_FOUND', message: `Unknown package ${packageId}`, field };
  if (pkg.canceled) return { code: 'INVALID_STATE', message: `Package ${packageId} is canceled`, field };
  const served = catalog.productFormats(pkg.product_id);
  if (!served.has(creative.format_option_id)) {
    return { code: 'FORMAT_NOT_SUPPORTED', message: `Package ${packageId} (${pkg.product_id}) serves ${[...served].map(id => catalog.label(id)).join(', ')}; creative ${creativeId} is ${catalog.label(creative.format_option_id)}`, field };
  }
  return undefined;
}

export function assign(pkg: PackageRecord, creativeId: string, weight: number | undefined, nowIso: string): void {
  pkg.creative_assignments ??= [];
  const existing = pkg.creative_assignments.find(assignment => assignment.creative_id === creativeId);
  if (existing) {
    if (weight !== undefined) existing.weight = weight;
    return;
  }
  pkg.creative_assignments.push({ creative_id: creativeId, ...(weight !== undefined && { weight }), assigned_date: nowIso });
}

export function unassign(pkg: PackageRecord, creativeId: string): void {
  if (!pkg.creative_assignments) return;
  pkg.creative_assignments = pkg.creative_assignments.filter(assignment => assignment.creative_id !== creativeId);
  if (pkg.creative_assignments.length === 0) delete pkg.creative_assignments;
}

function weightOf(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !(value >= 0 && value <= 100)) {
    throw new CreativeRequestError([{ code: 'INVALID_REQUEST', message: 'weight must be a number from 0 to 100', field }]);
  }
  return value;
}

function unsupportedFields(input: Json, field: string): CreativeError | undefined {
  const present = UNSUPPORTED_ASSIGNMENT_FIELDS.filter(key => input[key] !== undefined);
  return present.length > 0
    ? { code: 'UNSUPPORTED_FEATURE', message: `This seller does not support ${present.join(', ')} on assignments`, field: `${field}.${present[0]}` }
    : undefined;
}

/** The packages a creative is assigned to. */
function assignedTo(doc: MarketDocument, accountId: string, creativeId: string): string[] {
  return [...accountPackages(doc, accountId).values()]
    .filter(({ pkg }) => pkg.creative_assignments?.some(assignment => assignment.creative_id === creativeId))
    .map(({ pkg }) => pkg.package_id);
}

/**
 * sync_creatives against a copy of the caller's market document. Returns the
 * wire payload; the caller saves `doc` unless the request was a dry run or
 * failed. `strict` validation fails the whole request on any creative error,
 * and `assignment_operations` are always applied all-or-nothing.
 */
export function syncCreatives(doc: MarketDocument, accountId: string, req: Json, catalog: CreativeCatalog, nowIso: string): { payload: Json; persist: boolean } {
  const fail = (errors: CreativeError[]) => ({ payload: { errors }, persist: false });
  try {
    const creatives = Array.isArray(req.creatives) ? req.creatives : [];
    const legacy = Array.isArray(req.assignments) ? req.assignments as unknown[] : [];
    const operations = Array.isArray(req.assignment_operations) ? req.assignment_operations as unknown[] : [];
    if (creatives.length === 0 && legacy.length === 0 && operations.length === 0) {
      return fail([{ code: 'INVALID_REQUEST', message: 'Send creatives, assignments or assignment_operations' }]);
    }
    if (creatives.length > MAX_CREATIVES_PER_REQUEST) {
      return fail([{ code: 'INVALID_REQUEST', message: `Send at most ${MAX_CREATIVES_PER_REQUEST} creatives per request`, field: 'creatives' }]);
    }
    const lenient = req.validation_mode === 'lenient' && operations.length === 0;
    const rows = new Map<string, Json>();

    const parsed = creatives.map((input, index) => ({ index, result: parseCreative(input, `creatives[${index}]`, catalog) }));
    const invalid = parsed.flatMap(({ result }) => ('error' in result ? [result.error] : []));
    if (invalid.length > 0 && !lenient) return fail(invalid);
    for (const { index, result } of parsed) {
      if ('error' in result) {
        const id = isObject(creatives[index]) && typeof creatives[index].creative_id === 'string' ? creatives[index].creative_id : `creatives[${index}]`;
        rows.set(id as string, { creative_id: id, action: 'failed', errors: [result.error] });
        continue;
      }
      rows.set(result.creative.creative_id, { creative_id: result.creative.creative_id, action: upsertCreative(doc, accountId, result.creative, nowIso) });
    }

    if (req.delete_missing === true && creatives.length > 0) {
      // Every creative the request named stays, including one that failed
      // lenient validation: its library version is left as it was.
      const kept = new Set(creatives.flatMap(input => (isObject(input) && typeof input.creative_id === 'string' ? [input.creative_id] : [])));
      for (const creative of libraryOf(doc).filter(candidate => candidate.account_id === accountId && !kept.has(candidate.creative_id))) {
        for (const { pkg } of accountPackages(doc, accountId).values()) unassign(pkg, creative.creative_id);
        rows.set(creative.creative_id, { creative_id: creative.creative_id, action: 'deleted' });
      }
      doc.creatives = libraryOf(doc).filter(candidate => candidate.account_id !== accountId || kept.has(candidate.creative_id));
    }

    const packages = accountPackages(doc, accountId);
    const touch = (creativeId: string) => {
      if (!rows.has(creativeId)) rows.set(creativeId, { creative_id: creativeId, action: 'unchanged' });
      return rows.get(creativeId)!;
    };

    // Deprecated additive assignments: each failure is reported on its
    // creative's row, and the rest still apply.
    legacy.forEach((input, index) => {
      const field = `assignments[${index}]`;
      if (!isObject(input) || typeof input.creative_id !== 'string' || typeof input.package_id !== 'string') {
        throw new CreativeRequestError([{ code: 'INVALID_REQUEST', message: 'Each assignment needs creative_id and package_id', field }]);
      }
      const row = touch(input.creative_id);
      const error = unsupportedFields(input, field)
        ?? assignmentError(doc, accountId, catalog, input.creative_id, packages.get(input.package_id)?.pkg, input.package_id, field);
      if (error) {
        row.assignment_errors = { ...(row.assignment_errors as Json | undefined), [input.package_id]: error.message };
        return;
      }
      assign(packages.get(input.package_id)!.pkg, input.creative_id, weightOf(input.weight, `${field}.weight`), nowIso);
    });

    // Explicit operations: validate every one in order, then apply all.
    const errors: CreativeError[] = [];
    operations.forEach((input, index) => {
      const field = `assignment_operations[${index}]`;
      if (!isObject(input) || typeof input.creative_id !== 'string' || typeof input.package_id !== 'string') {
        errors.push({ code: 'INVALID_REQUEST', message: 'Each operation needs operation, creative_id and package_id', field });
        return;
      }
      const pkg = packages.get(input.package_id)?.pkg;
      const unsupported = unsupportedFields(input, field);
      if (unsupported) {
        errors.push(unsupported);
        return;
      }
      switch (input.operation) {
        case 'assign': {
          const error = assignmentError(doc, accountId, catalog, input.creative_id, pkg, input.package_id, field);
          if (error) errors.push(error);
          else assign(pkg!, input.creative_id, weightOf(input.weight, `${field}.weight`), nowIso);
          break;
        }
        case 'unassign':
          if (!pkg) errors.push({ code: 'PACKAGE_NOT_FOUND', message: `Unknown package ${input.package_id}`, field });
          else unassign(pkg, input.creative_id);
          break;
        case 'replace': {
          const replaced = input.replaces_creative_id;
          const error = assignmentError(doc, accountId, catalog, input.creative_id, pkg, input.package_id, field);
          if (error) errors.push(error);
          else if (typeof replaced !== 'string' || !pkg!.creative_assignments?.some(assignment => assignment.creative_id === replaced)) {
            errors.push({ code: 'INVALID_STATE', message: `Creative ${String(replaced)} is not assigned to package ${input.package_id}`, field: `${field}.replaces_creative_id` });
          } else {
            unassign(pkg!, replaced);
            assign(pkg!, input.creative_id, weightOf(input.weight, `${field}.weight`), nowIso);
            touch(replaced);
          }
          break;
        }
        case 'merge':
          errors.push({ code: 'UNSUPPORTED_FEATURE', message: 'This seller does not merge creatives', field: `${field}.operation` });
          break;
        default:
          errors.push({ code: 'INVALID_REQUEST', message: `Unknown operation ${String(input.operation)}`, field: `${field}.operation` });
      }
      touch(input.creative_id);
    });
    if (errors.length > 0) return fail(errors);

    const result = [...rows.values()].map(row => {
      if (row.action === 'failed' || row.action === 'deleted') return row;
      return { ...row, status: 'approved', assigned_to: assignedTo(doc, accountId, row.creative_id as string) };
    });
    const dryRun = req.dry_run === true;
    return { payload: { creatives: result, ...(dryRun && { dry_run: true }), sandbox: true }, persist: !dryRun };
  } catch (error) {
    if (error instanceof CreativeRequestError) return fail(error.errors);
    throw error;
  }
}

/** list_creatives over the account's library. */
export function listCreatives(doc: MarketDocument, accountId: string, req: Json, catalog: CreativeCatalog): Json {
  const filters = isObject(req.filters) ? req.filters : {};
  const ids = Array.isArray(filters.creative_ids) ? new Set(filters.creative_ids as string[]) : undefined;
  const formats = catalog.filter(filters);
  const statuses = Array.isArray(filters.statuses) ? new Set(filters.statuses as string[]) : undefined;
  const packageIds = Array.isArray(filters.assigned_to_packages) ? new Set(filters.assigned_to_packages as string[]) : undefined;
  const buyIds = Array.isArray(filters.media_buy_ids) ? new Set(filters.media_buy_ids as string[]) : undefined;
  const packages = accountPackages(doc, accountId);
  const assignmentsOf = (creativeId: string) => [...packages.values()].flatMap(({ buy, pkg }) => {
    const assignment = pkg.creative_assignments?.find(candidate => candidate.creative_id === creativeId);
    return assignment ? [{ package_id: pkg.package_id, media_buy_id: buy.media_buy_id, assigned_date: assignment.assigned_date, approval_status: 'approved' }] : [];
  });
  const matching = libraryOf(doc)
    .filter(creative => creative.account_id === accountId)
    .filter(creative => (!ids || ids.has(creative.creative_id)) && (!formats || formats.has(creative.format_option_id)) && (!statuses || statuses.has('approved')))
    .filter(creative => {
      if (!packageIds && !buyIds && filters.unassigned !== true) return true;
      const assigned = assignmentsOf(creative.creative_id);
      if (filters.unassigned === true && assigned.length > 0) return false;
      if (packageIds && !assigned.some(assignment => packageIds.has(assignment.package_id))) return false;
      return !buyIds || assigned.some(assignment => buyIds.has(assignment.media_buy_id));
    })
    .sort((a, b) => (a.created_date === b.created_date ? (a.creative_id < b.creative_id ? -1 : 1) : a.created_date < b.created_date ? -1 : 1));
  const pagination = isObject(req.pagination) ? req.pagination : {};
  const max = typeof pagination.max_results === 'number' ? Math.max(1, Math.min(100, pagination.max_results)) : 50;
  const offset = typeof pagination.cursor === 'string' && /^\d+$/.test(pagination.cursor) ? Number(pagination.cursor) : 0;
  const page = matching.slice(offset, offset + max);
  const includeAssignments = req.include_assignments !== false;
  return {
    query_summary: { total_matching: matching.length, returned: page.length },
    pagination: {
      has_more: offset + page.length < matching.length,
      ...(offset + page.length < matching.length && { cursor: String(offset + page.length) }),
      total_count: matching.length,
    },
    creatives: page.map(creative => {
      const assigned = assignmentsOf(creative.creative_id);
      return {
        creative_id: creative.creative_id,
        name: creative.name,
        ...catalog.wire(creative.format_option_id),
        status: 'approved',
        created_date: creative.created_date,
        updated_date: creative.updated_date,
        assets: creative.assets,
        ...(includeAssignments && { assignments: { assignment_count: assigned.length, ...(assigned.length > 0 && { assigned_packages: assigned }) } }),
      };
    }),
    sandbox: true,
  };
}

/** The approval of each creative assigned to a package, for get_media_buys. */
export function creativeApprovals(pkg: PackageRecord): Json[] | undefined {
  return pkg.creative_assignments?.map(assignment => ({ creative_id: assignment.creative_id, approval_status: 'approved' }));
}
