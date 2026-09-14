/**
 * Frequency-cap capability, matching, and enforcement for the training seller.
 *
 * Implements the "Frequency-cap scope and product support" section of
 * docs/media-buy/specification.mdx:
 *
 * - Package caps live in `packages[].targeting_overlay.frequency_cap` and own
 *   one independent counter per package. Product support is either the legacy
 *   broad `overlay_support.frequency_cap: true` or the structured
 *   `overlay_support.frequency_cap_support` constraints. Omitted structured
 *   fields inherit the seller-wide `media_buy.frequency_capping` declaration
 *   and never broaden it.
 * - A root `frequency_cap` on a MediaBuy owns one counter shared across every
 *   package. The seller advertises the complete executable domain as
 *   `media_buy.aggregate_frequency_capping`; products opt in through
 *   `media_buy_support.frequency_cap: true`, optionally narrowed by
 *   `frequency_cap_constraints`.
 * - A cap outside capability is rejected with UNSUPPORTED_FEATURE before any
 *   mutation and is never clamped.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FrequencyCapTaskError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
  recovery?: string;
}

/** Reach-unit values the training seller can count caps against. `custom`
 * is excluded because it does not identify a countable entity. */
export const TRAINING_FREQUENCY_CAP_PER_UNITS = [
  'individuals',
  'households',
  'devices',
  'accounts',
  'cookies',
] as const;

/** Duration units accepted for package cap windows and suppression periods. */
export const TRAINING_FREQUENCY_CAP_WINDOW_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'days',
  'campaign',
] as const;

/** Seller-wide package frequency capping (`media_buy.frequency_capping`). */
export const TRAINING_PACKAGE_FREQUENCY_CAPPING = Object.freeze({
  supported_per_units: [...TRAINING_FREQUENCY_CAP_PER_UNITS],
  supported_window_units: [...TRAINING_FREQUENCY_CAP_WINDOW_UNITS],
});

/** Seller-wide aggregate MediaBuy capping
 * (`media_buy.aggregate_frequency_capping`). Unlike product detail this is a
 * complete executable domain: nothing here is inherited or implied. */
export const TRAINING_AGGREGATE_FREQUENCY_CAPPING = Object.freeze({
  supported_control_modes: ['max_impressions'],
  supported_per_units: [...TRAINING_FREQUENCY_CAP_PER_UNITS],
  max_impressions_constraints: { minimum: 1, maximum: 50 },
  window_constraints: [
    { unit: 'hours', minimum_interval: 1, maximum_interval: 168 },
    { unit: 'days', minimum_interval: 1, maximum_interval: 90 },
    { unit: 'campaign', allowed_intervals: [1] },
  ],
});

type IntervalConstraint = {
  unit: string;
  minimum_interval?: number;
  maximum_interval?: number;
  allowed_intervals?: number[];
};

type CountConstraint = {
  minimum?: number;
  maximum?: number;
  allowed_values?: number[];
};

/** Structured constraints after seller-wide inheritance. A missing list means
 * the dimension is unconstrained beyond the seller-wide declaration. */
export interface ResolvedFrequencyCapConstraints {
  /** `undefined` means update support is undeclared (broad legacy meaning). */
  mutableFields?: string[];
  controlModes?: string[];
  perUnits: string[];
  maxImpressions?: CountConstraint;
  /** Window unit → interval constraint. `undefined` intervals mean every
   * interval for that unit. */
  windowUnits: Map<string, IntervalConstraint | undefined>;
  suppressionUnits: Map<string, IntervalConstraint | undefined>;
}

export type PackageFrequencyCapSupport =
  | { kind: 'none' }
  | { kind: 'legacy'; constraints: ResolvedFrequencyCapConstraints }
  | { kind: 'structured'; constraints: ResolvedFrequencyCapConstraints };

export interface MediaBuyFrequencyCapSupport {
  participates: boolean;
  constraints?: ResolvedFrequencyCapConstraints;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? [...(value as string[])]
    : undefined;
}

function intervalConstraints(value: unknown): IntervalConstraint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(isRecord).filter(entry => typeof entry.unit === 'string');
  return entries.map(entry => ({
    unit: entry.unit as string,
    ...(typeof entry.minimum_interval === 'number' && { minimum_interval: entry.minimum_interval }),
    ...(typeof entry.maximum_interval === 'number' && { maximum_interval: entry.maximum_interval }),
    ...(Array.isArray(entry.allowed_intervals) && {
      allowed_intervals: entry.allowed_intervals.filter((interval): interval is number => typeof interval === 'number'),
    }),
  }));
}

function countConstraint(value: unknown): CountConstraint | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.minimum === 'number' && { minimum: value.minimum }),
    ...(typeof value.maximum === 'number' && { maximum: value.maximum }),
    ...(Array.isArray(value.allowed_values) && {
      allowed_values: value.allowed_values.filter((count): count is number => typeof count === 'number'),
    }),
  };
}

function unitMap(
  declared: IntervalConstraint[] | undefined,
  sellerWide: readonly string[],
): Map<string, IntervalConstraint | undefined> {
  if (declared) return new Map(declared.map(entry => [entry.unit, entry]));
  return new Map(sellerWide.map(unit => [unit, undefined]));
}

/** Resolve structured product constraints against a seller-wide declaration.
 * Omitted product fields inherit; a product value absent from the seller-wide
 * declaration is dropped because it is invalid rather than broadening. */
function resolveConstraints(
  declared: Record<string, unknown> | undefined,
  sellerWide: {
    perUnits: readonly string[];
    windowUnits: readonly string[];
    controlModes?: readonly string[];
    maxImpressions?: CountConstraint;
    windowConstraints?: IntervalConstraint[];
  },
): ResolvedFrequencyCapConstraints {
  const declaredPerUnits = stringArray(declared?.supported_per_units);
  const declaredControlModes = stringArray(declared?.supported_control_modes);
  const declaredWindows = intervalConstraints(declared?.window_constraints);
  const declaredSuppression = intervalConstraints(declared?.suppression_constraints);
  const perUnits = (declaredPerUnits ?? [...sellerWide.perUnits])
    .filter(unit => sellerWide.perUnits.includes(unit));
  const controlModes = declaredControlModes
    ? declaredControlModes.filter(mode => !sellerWide.controlModes || sellerWide.controlModes.includes(mode))
    : sellerWide.controlModes ? [...sellerWide.controlModes] : undefined;
  const windowSource = declaredWindows ?? sellerWide.windowConstraints;
  const windowUnits = unitMap(
    windowSource?.filter(entry => sellerWide.windowUnits.includes(entry.unit)),
    sellerWide.windowUnits,
  );
  const suppressionUnits = unitMap(
    declaredSuppression?.filter(entry => sellerWide.windowUnits.includes(entry.unit)),
    sellerWide.windowUnits,
  );
  return {
    ...(declared && Array.isArray(declared.mutable_fields) && {
      mutableFields: stringArray(declared.mutable_fields) ?? [],
    }),
    ...(controlModes && { controlModes }),
    perUnits,
    ...((countConstraint(declared?.max_impressions_constraints) ?? sellerWide.maxImpressions) && {
      maxImpressions: countConstraint(declared?.max_impressions_constraints) ?? sellerWide.maxImpressions,
    }),
    windowUnits,
    suppressionUnits,
  };
}

const PACKAGE_SELLER_WIDE = {
  perUnits: TRAINING_FREQUENCY_CAP_PER_UNITS,
  windowUnits: TRAINING_FREQUENCY_CAP_WINDOW_UNITS,
};

const AGGREGATE_SELLER_WIDE = {
  perUnits: TRAINING_AGGREGATE_FREQUENCY_CAPPING.supported_per_units,
  windowUnits: TRAINING_AGGREGATE_FREQUENCY_CAPPING.window_constraints.map(entry => entry.unit),
  controlModes: TRAINING_AGGREGATE_FREQUENCY_CAPPING.supported_control_modes,
  maxImpressions: TRAINING_AGGREGATE_FREQUENCY_CAPPING.max_impressions_constraints,
  windowConstraints: TRAINING_AGGREGATE_FREQUENCY_CAPPING.window_constraints as IntervalConstraint[],
};

function overlaySupportOf(product: unknown): Record<string, unknown> | undefined {
  return isRecord(product) && isRecord(product.overlay_support) ? product.overlay_support : undefined;
}

function mediaBuySupportOf(product: unknown): Record<string, unknown> | undefined {
  return isRecord(product) && isRecord(product.media_buy_support) ? product.media_buy_support : undefined;
}

/** Product-scoped package cap support after seller-wide inheritance. A product
 * that declares neither form has made no binding package-cap promise; the
 * seller-wide broad contract still applies when it accepts a cap. */
export function packageFrequencyCapSupport(product: unknown): PackageFrequencyCapSupport {
  const support = overlaySupportOf(product);
  if (support?.frequency_cap === true) {
    return { kind: 'legacy', constraints: resolveConstraints(undefined, PACKAGE_SELLER_WIDE) };
  }
  if (isRecord(support?.frequency_cap_support)) {
    return {
      kind: 'structured',
      constraints: resolveConstraints(support.frequency_cap_support, PACKAGE_SELLER_WIDE),
    };
  }
  return { kind: 'none' };
}

/** Product participation in the shared MediaBuy counter. */
export function mediaBuyFrequencyCapSupport(product: unknown): MediaBuyFrequencyCapSupport {
  const support = mediaBuySupportOf(product);
  if (support?.frequency_cap !== true) return { participates: false };
  return {
    participates: true,
    constraints: resolveConstraints(
      isRecord(support.frequency_cap_constraints) ? support.frequency_cap_constraints : undefined,
      AGGREGATE_SELLER_WIDE,
    ),
  };
}

/** Whether a product can change package caps after creation. `undefined`
 * mutable fields (legacy or omitted) means every field may change. */
export function packageFrequencyCapMutableFields(product: unknown): string[] | undefined {
  const support = packageFrequencyCapSupport(product);
  if (support.kind === 'none') return undefined;
  return support.constraints.mutableFields;
}

export function packageFrequencyCapIsMutable(product: unknown): boolean {
  const support = packageFrequencyCapSupport(product);
  if (support.kind === 'none') return true;
  const mutable = support.constraints.mutableFields;
  return mutable === undefined || mutable.length > 0;
}

/** Whether a product's implementation can change the root cap after creation.
 * Participation is required; `mutable_fields: []` is create-only. */
export function mediaBuyFrequencyCapIsMutable(product: unknown): boolean {
  const support = mediaBuyFrequencyCapSupport(product);
  if (!support.participates) return false;
  const mutable = support.constraints?.mutableFields;
  return mutable === undefined || mutable.length > 0;
}

// ── Discovery matching ───────────────────────────────────────────────────

function subset(required: unknown, available: readonly string[] | undefined): boolean {
  if (required === undefined) return true;
  const values = stringArray(required);
  if (!values) return false;
  if (available === undefined) return true;
  return values.every(value => available.includes(value));
}

function requirementMatchesConstraints(
  requirement: Record<string, unknown>,
  constraints: ResolvedFrequencyCapConstraints,
): boolean {
  if (requirement.mutable_fields !== undefined) {
    const required = stringArray(requirement.mutable_fields);
    if (!required) return false;
    // Omitted product mutable_fields keeps the broad legacy meaning and
    // matches any requirement; an empty list is create-only and never
    // matches a non-empty requirement.
    if (constraints.mutableFields !== undefined
      && !required.every(field => constraints.mutableFields!.includes(field))) return false;
  }
  if (!subset(requirement.supported_control_modes, constraints.controlModes)) return false;
  if (!subset(requirement.supported_per_units, constraints.perUnits)) return false;
  if (!subset(requirement.supported_window_units, [...constraints.windowUnits.keys()])) return false;
  if (!subset(requirement.supported_suppression_units, [...constraints.suppressionUnits.keys()])) return false;
  return true;
}

/** `required_overlay_support.frequency_cap_support` containment. Legacy
 * `frequency_cap: true` satisfies every structured requirement. */
export function packageFrequencyCapRequirementMatches(product: unknown, requirement: unknown): boolean {
  if (!isRecord(requirement)) return false;
  const support = packageFrequencyCapSupport(product);
  if (support.kind === 'none') return false;
  // Legacy `frequency_cap: true` keeps its broad meaning within seller-wide
  // limits: it has no mutable_fields ceiling, but a requested unit the seller
  // never enforces is invalid rather than promised.
  return requirementMatchesConstraints(requirement, support.constraints);
}

/** `required_media_buy_support` containment. */
export function mediaBuySupportRequirementMatches(product: unknown, requirement: unknown): boolean {
  if (!isRecord(requirement)) return false;
  const support = mediaBuyFrequencyCapSupport(product);
  if (requirement.frequency_cap === true && !support.participates) return false;
  if (requirement.frequency_cap_constraints !== undefined) {
    if (!isRecord(requirement.frequency_cap_constraints) || !support.participates || !support.constraints) return false;
    if (!requirementMatchesConstraints(requirement.frequency_cap_constraints, support.constraints)) return false;
  }
  return true;
}

// ── Cap validation ───────────────────────────────────────────────────────

function capControlMode(cap: Record<string, unknown>): string | undefined {
  const hasMax = cap.max_impressions !== undefined;
  const hasSuppress = cap.suppress !== undefined || cap.suppress_minutes !== undefined;
  if (hasMax && hasSuppress) return 'max_impressions_and_suppress';
  if (hasMax) return 'max_impressions';
  if (hasSuppress) return 'suppress';
  return undefined;
}

function countAllowed(count: number, constraint: CountConstraint | undefined): boolean {
  if (!constraint) return true;
  if (constraint.allowed_values) return constraint.allowed_values.includes(count);
  if (constraint.minimum !== undefined && count < constraint.minimum) return false;
  if (constraint.maximum !== undefined && count > constraint.maximum) return false;
  return true;
}

function intervalAllowed(interval: number, constraint: IntervalConstraint | undefined): boolean {
  if (!constraint) return true;
  if (constraint.allowed_intervals) return constraint.allowed_intervals.includes(interval);
  if (constraint.minimum_interval !== undefined && interval < constraint.minimum_interval) return false;
  if (constraint.maximum_interval !== undefined && interval > constraint.maximum_interval) return false;
  return true;
}

function durationRejection(
  value: unknown,
  units: Map<string, IntervalConstraint | undefined>,
  field: string,
  label: string,
): FrequencyCapTaskError | undefined {
  if (!isRecord(value) || typeof value.unit !== 'string' || typeof value.interval !== 'number') return undefined;
  if (!units.has(value.unit)) {
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: `${label} unit "${value.unit}" is not supported for this product.`,
      field: `${field}.unit`,
      recovery: 'correctable',
      details: { supported_units: [...units.keys()] },
    };
  }
  const constraint = units.get(value.unit);
  if (!intervalAllowed(value.interval, constraint)) {
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: `${label} interval ${value.interval} ${value.unit} is outside the supported range for this product.`,
      field: `${field}.interval`,
      recovery: 'correctable',
      details: { unit: value.unit, ...constraint },
    };
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function malformedDuration(value: unknown): boolean {
  return !isRecord(value) || !isPositiveInteger(value.interval) || typeof value.unit !== 'string';
}

/** Structural check for a cap value before capability matching. The legacy
 * create and update facades do not validate package overlays against
 * core/frequency-cap.json, so reject malformed shapes here rather than
 * persisting and echoing them. */
export function frequencyCapShapeError(cap: unknown, path: string): FrequencyCapTaskError | undefined {
  if (!isRecord(cap)) {
    return { code: 'INVALID_REQUEST', message: 'frequency_cap must be an object.', field: path, recovery: 'correctable' };
  }
  const invalid = (field: string, message: string): FrequencyCapTaskError => ({
    code: 'INVALID_REQUEST',
    message,
    field: `${path}.${field}`,
    recovery: 'correctable',
  });
  if (cap.max_impressions !== undefined) {
    if (!isPositiveInteger(cap.max_impressions)) {
      return invalid('max_impressions', 'frequency_cap.max_impressions must be a positive integer.');
    }
    if (typeof cap.per !== 'string') return invalid('per', 'frequency_cap.per is required with max_impressions.');
    if (malformedDuration(cap.window)) return invalid('window', 'frequency_cap.window must carry a positive integer interval and a unit.');
  } else if (cap.per !== undefined || cap.window !== undefined) {
    return invalid('max_impressions', 'frequency_cap.per and frequency_cap.window require max_impressions.');
  }
  if (cap.suppress !== undefined && malformedDuration(cap.suppress)) {
    return invalid('suppress', 'frequency_cap.suppress must carry a positive integer interval and a unit.');
  }
  if (cap.suppress_minutes !== undefined && (typeof cap.suppress_minutes !== 'number' || cap.suppress_minutes < 0)) {
    return invalid('suppress_minutes', 'frequency_cap.suppress_minutes must be a non-negative number.');
  }
  if (cap.max_impressions === undefined && cap.suppress === undefined && cap.suppress_minutes === undefined) {
    return invalid('max_impressions', 'frequency_cap requires max_impressions, suppress, or suppress_minutes.');
  }
  return undefined;
}

/** Validate one cap value against resolved constraints. Returns the first
 * INVALID_REQUEST or UNSUPPORTED_FEATURE rejection, or `undefined` when the
 * cap is executable. */
export function frequencyCapConstraintError(
  cap: unknown,
  constraints: ResolvedFrequencyCapConstraints,
  path: string,
  scope: 'package' | 'media_buy',
): FrequencyCapTaskError | undefined {
  if (!isRecord(cap)) return undefined;
  const shapeError = frequencyCapShapeError(cap, path);
  if (shapeError) return shapeError;
  const mode = capControlMode(cap);
  if (mode && constraints.controlModes && !constraints.controlModes.includes(mode)) {
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: scope === 'media_buy'
        ? 'A MediaBuy frequency cap must be a max_impressions cap.'
        : `The frequency_cap control mode "${mode}" is not supported for this product.`,
      field: path,
      recovery: 'correctable',
      details: { supported_control_modes: constraints.controlModes },
    };
  }
  if (cap.max_impressions !== undefined) {
    if (typeof cap.per === 'string' && !constraints.perUnits.includes(cap.per)) {
      return {
        code: 'UNSUPPORTED_FEATURE',
        message: `frequency_cap.per "${cap.per}" is not supported for this product.`,
        field: `${path}.per`,
        recovery: 'correctable',
        details: { supported_per_units: constraints.perUnits },
      };
    }
    if (typeof cap.max_impressions === 'number' && !countAllowed(cap.max_impressions, constraints.maxImpressions)) {
      return {
        code: 'UNSUPPORTED_FEATURE',
        message: `frequency_cap.max_impressions ${cap.max_impressions} is outside the supported values for this product.`,
        field: `${path}.max_impressions`,
        recovery: 'correctable',
        details: { ...constraints.maxImpressions },
      };
    }
    const windowError = durationRejection(cap.window, constraints.windowUnits, `${path}.window`, 'frequency_cap.window');
    if (windowError) return windowError;
  }
  if (cap.suppress !== undefined) {
    const suppressError = durationRejection(
      cap.suppress,
      constraints.suppressionUnits,
      `${path}.suppress`,
      'frequency_cap.suppress',
    );
    if (suppressError) return suppressError;
  }
  if (typeof cap.suppress_minutes === 'number' && !constraints.suppressionUnits.has('minutes')) {
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: 'frequency_cap.suppress_minutes is not supported for this product.',
      field: `${path}.suppress_minutes`,
      recovery: 'correctable',
      details: { supported_units: [...constraints.suppressionUnits.keys()] },
    };
  }
  return undefined;
}

/** Package cap validation against the selected product's resolved support. A
 * product that declares no package-cap support is held to the seller-wide
 * broad contract, matching pre-3.2 behavior. */
export function packageFrequencyCapError(
  product: unknown,
  cap: unknown,
  path: string,
): FrequencyCapTaskError | undefined {
  if (cap === undefined || cap === null) return undefined;
  const support = packageFrequencyCapSupport(product);
  const constraints = support.kind === 'none'
    ? resolveConstraints(undefined, PACKAGE_SELLER_WIDE)
    : support.constraints;
  return frequencyCapConstraintError(cap, constraints, path, 'package');
}

/** Root cap validation: the seller-wide domain plus every selected product's
 * participation and resolved constraints. `products` are the products of the
 * packages the request would leave active. */
export function mediaBuyFrequencyCapError(
  cap: unknown,
  products: ReadonlyArray<{ productId: string; product: unknown; field: string }>,
  path: string,
): FrequencyCapTaskError | undefined {
  if (cap === undefined || cap === null) return undefined;
  const sellerWide = resolveConstraints(undefined, AGGREGATE_SELLER_WIDE);
  const sellerWideError = frequencyCapConstraintError(cap, sellerWide, path, 'media_buy');
  if (sellerWideError) return sellerWideError;
  for (const { productId, product, field } of products) {
    const support = mediaBuyFrequencyCapSupport(product);
    if (!support.participates || !support.constraints) {
      return {
        code: 'UNSUPPORTED_FEATURE',
        message: `Product "${productId}" cannot participate in a shared MediaBuy frequency cap.`,
        field,
        recovery: 'correctable',
        details: { product_id: productId, reason: 'no_media_buy_frequency_cap_participation' },
      };
    }
    const productError = frequencyCapConstraintError(cap, support.constraints, path, 'media_buy');
    if (productError) {
      return {
        ...productError,
        message: `Product "${productId}": ${productError.message}`,
        details: { product_id: productId, ...(isRecord(productError.details) ? productError.details : {}) },
      };
    }
  }
  return undefined;
}

/** A product participates in the exact aggregate value requested during
 * discovery: seller-wide executable and within the product's constraints. */
export function productExecutesMediaBuyFrequencyCap(product: unknown, cap: unknown): boolean {
  if (!isRecord(product) || typeof product.product_id !== 'string') return false;
  return mediaBuyFrequencyCapError(
    cap,
    [{ productId: product.product_id, product, field: 'media_buy_frequency_cap' }],
    'media_buy_frequency_cap',
  ) === undefined;
}

// ── Update boundaries ────────────────────────────────────────────────────

const LOGICAL_CAP_FIELDS: ReadonlyArray<{ field: string; keys: string[] }> = [
  { field: 'max_impressions', keys: ['max_impressions'] },
  { field: 'per', keys: ['per'] },
  { field: 'window', keys: ['window'] },
  { field: 'suppress', keys: ['suppress', 'suppress_minutes'] },
];

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Logical cap fields whose value differs between two caps. */
export function changedFrequencyCapFields(before: unknown, after: unknown): string[] {
  const prior = isRecord(before) ? before : {};
  const next = isRecord(after) ? after : {};
  return LOGICAL_CAP_FIELDS
    .filter(({ keys }) => keys.some(key => !sameJson(prior[key], next[key])))
    .map(({ field }) => field);
}

/** A package-cap change to a field outside `mutable_fields` is a cap shape the
 * product cannot execute after creation. */
export function packageFrequencyCapChangeError(
  product: unknown,
  before: unknown,
  after: unknown,
  path: string,
): FrequencyCapTaskError | undefined {
  const mutable = packageFrequencyCapMutableFields(product);
  if (mutable === undefined) return undefined;
  const changed = changedFrequencyCapFields(before, after).filter(field => !mutable.includes(field));
  if (changed.length === 0) return undefined;
  return {
    code: 'UNSUPPORTED_FEATURE',
    message: `The selected product cannot change frequency_cap.${changed[0]} after creation.`,
    field: `${path}.${changed[0]}`,
    recovery: 'correctable',
    details: { mutable_fields: mutable, changed_fields: changed },
  };
}

/** A root-cap replacement that changes a field outside a participating
 * product's `frequency_cap_constraints.mutable_fields`. Clearing the cap or
 * setting one on an uncapped buy is governed by the action alone, so this only
 * applies when both caps are present. */
export function mediaBuyFrequencyCapChangeError(
  before: unknown,
  after: unknown,
  products: ReadonlyArray<{ productId: string; product: unknown }>,
  path: string,
): FrequencyCapTaskError | undefined {
  if (!isRecord(before) || !isRecord(after)) return undefined;
  const changed = changedFrequencyCapFields(before, after);
  if (changed.length === 0) return undefined;
  for (const { productId, product } of products) {
    const mutable = mediaBuyFrequencyCapSupport(product).constraints?.mutableFields;
    if (mutable === undefined) continue;
    const blocked = changed.filter(field => !mutable.includes(field));
    if (blocked.length === 0) continue;
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: `Product "${productId}" cannot change frequency_cap.${blocked[0]} after creation.`,
      field: `${path}.${blocked[0]}`,
      recovery: 'correctable',
      details: { product_id: productId, mutable_fields: mutable, changed_fields: changed },
    };
  }
  return undefined;
}
