/**
 * Brand Canonical Document Tools for Addie (#4527)
 *
 * Implements four MCP tools that author and validate distributed brand.json
 * documents per the 3.1 spec (docs/brand-protocol/brand-json.mdx):
 *
 *   publish_brand_canonical_document — generate a variant-5 Brand Canonical
 *     Document (the brand's own /.well-known/brand.json), validate it against
 *     the schema, and return the JSON for the operator to host.
 *
 *   add_to_brand_refs — for a house operator, append a portfolio_entry
 *     pointer to its brand_refs[] while enforcing the cross-array uniqueness
 *     invariants from the spec's Conformance section.
 *
 *   check_mutual_assertion — fetch the leaf's canonical document and its
 *     claimed house's portfolio (following House Redirects on the house side
 *     per Conformance) and classify the relationship into mutual / leaf_only
 *     / house_only / standalone / unverifiable.
 *
 *   notify_pending_verification — on a leaf_only edge, send the SHOULD-level
 *     notification to the house's contact.email. Rate-limited per
 *     {leaf, house} pair via brand_assertion_notifications. Behind a feature
 *     flag (BRAND_ASSERTION_EMAIL_ENABLED) — defaults to log-only so we don't
 *     enable a new email surface as part of this PR.
 *
 * Schema source of truth: static/schemas/source/brand.json (the same file
 * served as dist/schemas/latest/brand.json after build). We resolve $refs
 * within that one document — no network fetches at validate time.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Resend } from 'resend';

import type { AddieTool } from '../types.js';
import { createLogger } from '../../logger.js';
import { safeFetch } from '../../utils/url-security.js';
import { AAO_UA_VALIDATOR } from '../../config/user-agents.js';
import { query } from '../../db/client.js';

const logger = createLogger('brand-canonical-tools');

// ─── Schema loading ─────────────────────────────────────────────────────────

/** Cached compiled validator for the full brand.json schema. */
let cachedValidator: ValidateFunction | null = null;
let cachedSchema: Record<string, unknown> | null = null;

function resolveSchemaPath(refPath: string): string {
  // Repo-root paths look like "/schemas/enums/foo.json". Map them to the
  // source-of-truth files under static/schemas/source/.
  const rel = refPath.startsWith('/schemas/') ? refPath.slice('/schemas/'.length) : refPath;
  return join(process.cwd(), 'static/schemas/source', rel);
}

function loadBrandSchema(): Record<string, unknown> {
  if (cachedSchema) return cachedSchema;
  // Resolve from repo root — tsc-emitted JS lives under dist/, but Node's
  // process.cwd() in production runs is the repo root (set in fly.toml).
  // In tests vitest runs from the repo root too.
  const schemaPath = join(process.cwd(), 'static/schemas/source/brand.json');
  cachedSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  return cachedSchema;
}

/**
 * Pre-load every cross-file $ref the brand.json source schema can name. The
 * brand schema $refs the enum schemas via `/schemas/enums/...` ids; AJV
 * resolves those through `addSchema` calls before compile. We don't use
 * `compileAsync` because the lookups are local filesystem reads — sync
 * resolution keeps the validator factory simple.
 */
function preloadReferencedSchemas(ajv: Ajv): void {
  // Walk the brand schema for $refs that point at external schema files
  // and register them by id with AJV.
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string' && ref.startsWith('/schemas/') && !seen.has(ref)) {
      seen.add(ref);
      try {
        const referencedSchema = JSON.parse(readFileSync(resolveSchemaPath(ref), 'utf8')) as Record<
          string,
          unknown
        >;
        // AJV requires a stable $id so the $ref can resolve to it. Use the
        // /schemas/... path as the id since that's what the brand schema
        // names.
        if (typeof referencedSchema.$id !== 'string') {
          referencedSchema.$id = ref;
        }
        ajv.addSchema(referencedSchema, ref);
      } catch (err) {
        logger.warn({ err, ref }, 'Failed to preload referenced schema; validation may flag it as unresolvable');
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(loadBrandSchema());
}

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  preloadReferencedSchemas(ajv);
  cachedValidator = ajv.compile(loadBrandSchema());
  return cachedValidator;
}

function formatAjvErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((err) => {
    const path = err.instancePath || '(root)';
    const params = err.params ? ` (${JSON.stringify(err.params)})` : '';
    return `${path}: ${err.message ?? 'invalid'}${params}`;
  });
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

const BRAND_ID_PATTERN = /^[a-z0-9_]+$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

interface JsonError {
  error: string;
  hint?: string;
}

function errorJson(message: string, hint?: string): string {
  const payload: JsonError = { error: message };
  if (hint) payload.hint = hint;
  return JSON.stringify(payload);
}

// ─── Tool 1: publish_brand_canonical_document ───────────────────────────────

/**
 * Top-level fields permitted on a Brand Canonical Document. Anything else
 * the caller supplies (house, brands, brand_refs, redirect fields…) belongs
 * on a different variant and the schema's `not` clause would reject it; we
 * drop unknown keys instead of constructing an invalid document.
 */
const CANONICAL_DOC_TOP_LEVEL_KEYS = new Set([
  '$schema',
  'version',
  'last_updated',
  'house_domain',
  // brand definition fields
  'id',
  'url',
  'names',
  'keller_type',
  'parent_brand',
  'properties',
  'brand_agent',
  'rights_agent',
  'logos',
  'colors',
  'fonts',
  'tone',
  'tagline',
  'visual_guidelines',
  'trademarks',
  'description',
  'industries',
  'target_audience',
  'agents',
  'contact',
  'data_subject_contestation',
  'product_catalog',
  'voice',
  'avatar',
  'compliance_policies',
  'policy_categories',
  'disclaimers',
]);

interface PublishCanonicalArgs {
  domain: string;
  brand_id: string;
  names: Array<Record<string, string>>;
  house_domain?: string;
  keller_type?: 'master' | 'sub_brand' | 'endorsed' | 'independent';
  parent_brand?: string;
  logos?: unknown[];
  colors?: Record<string, unknown>;
  fonts?: Record<string, unknown>;
  tone?: Record<string, unknown>;
  tagline?: string;
  visual_guidelines?: Record<string, unknown>;
  trademarks?: unknown[];
  description?: string;
  industries?: string[];
  contact?: Record<string, unknown>;
  properties?: unknown[];
  brand_agent?: Record<string, unknown>;
  rights_agent?: Record<string, unknown>;
  version?: string;
  last_updated?: string;
  extra?: Record<string, unknown>;
}

function buildCanonicalDocument(args: PublishCanonicalArgs): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
    version: args.version ?? '1.0',
    id: args.brand_id,
    names: args.names,
  };

  if (args.house_domain) doc.house_domain = args.house_domain;
  if (args.keller_type) doc.keller_type = args.keller_type;
  if (args.parent_brand) doc.parent_brand = args.parent_brand;
  if (args.logos) doc.logos = args.logos;
  if (args.colors) doc.colors = args.colors;
  if (args.fonts) doc.fonts = args.fonts;
  if (args.tone) doc.tone = args.tone;
  if (args.tagline) doc.tagline = args.tagline;
  if (args.visual_guidelines) doc.visual_guidelines = args.visual_guidelines;
  if (args.trademarks) doc.trademarks = args.trademarks;
  if (args.description) doc.description = args.description;
  if (args.industries) doc.industries = args.industries;
  if (args.contact) doc.contact = args.contact;
  if (args.properties) doc.properties = args.properties;
  if (args.brand_agent) doc.brand_agent = args.brand_agent;
  if (args.rights_agent) doc.rights_agent = args.rights_agent;
  if (args.last_updated) doc.last_updated = args.last_updated;

  // Allow advanced callers to slip in additional canonical-doc fields via
  // `extra`, but ignore keys that don't belong on this variant.
  if (args.extra && typeof args.extra === 'object') {
    for (const [key, value] of Object.entries(args.extra)) {
      if (CANONICAL_DOC_TOP_LEVEL_KEYS.has(key)) {
        doc[key] = value;
      }
    }
  }

  return doc;
}

export interface PublishCanonicalResult {
  ok: boolean;
  document?: Record<string, unknown>;
  hosting_path?: string;
  errors?: string[];
}

export function publishBrandCanonicalDocument(
  args: PublishCanonicalArgs,
): PublishCanonicalResult {
  const domain = normalizeDomain(args.domain);
  if (!DOMAIN_PATTERN.test(domain)) {
    return { ok: false, errors: [`domain: invalid (${args.domain})`] };
  }
  if (!BRAND_ID_PATTERN.test(args.brand_id)) {
    return {
      ok: false,
      errors: [`brand_id: must match ^[a-z0-9_]+$ (got "${args.brand_id}")`],
    };
  }
  if (!Array.isArray(args.names) || args.names.length === 0) {
    return { ok: false, errors: ['names: must be a non-empty array of localized name objects'] };
  }
  if (args.house_domain && !DOMAIN_PATTERN.test(normalizeDomain(args.house_domain))) {
    return { ok: false, errors: [`house_domain: invalid (${args.house_domain})`] };
  }

  const normalizedArgs: PublishCanonicalArgs = {
    ...args,
    domain,
    house_domain: args.house_domain ? normalizeDomain(args.house_domain) : undefined,
  };

  const document = buildCanonicalDocument(normalizedArgs);

  const validate = getValidator();
  const valid = validate(document);
  if (!valid) {
    return { ok: false, document, errors: formatAjvErrors(validate) };
  }

  return {
    ok: true,
    document,
    hosting_path: `https://${domain}/.well-known/brand.json`,
  };
}

// ─── Tool 2: add_to_brand_refs ──────────────────────────────────────────────

interface AddBrandRefArgs {
  house_brand_json?: Record<string, unknown>;
  house_domain?: string;
  child_domain: string;
  brand_id: string;
  managed_by?: string;
  effective_at?: string;
}

export interface AddBrandRefResult {
  ok: boolean;
  brand_json?: Record<string, unknown>;
  errors?: string[];
}

async function fetchBrandJson(
  domain: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const url = `https://${domain}/.well-known/brand.json`;
  try {
    const response = await safeFetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': AAO_UA_VALIDATOR,
      },
      maxRedirects: 3,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} fetching ${url}` };
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `Invalid JSON at ${url}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: `brand.json at ${url} is not an object` };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to fetch ${url}: ${message}` };
  }
}

export async function addToBrandRefs(args: AddBrandRefArgs): Promise<AddBrandRefResult> {
  const childDomain = normalizeDomain(args.child_domain);
  if (!DOMAIN_PATTERN.test(childDomain)) {
    return { ok: false, errors: [`child_domain: invalid (${args.child_domain})`] };
  }
  if (!BRAND_ID_PATTERN.test(args.brand_id)) {
    return {
      ok: false,
      errors: [`brand_id: must match ^[a-z0-9_]+$ (got "${args.brand_id}")`],
    };
  }
  if (args.managed_by) {
    const mb = normalizeDomain(args.managed_by);
    if (!DOMAIN_PATTERN.test(mb)) {
      return { ok: false, errors: [`managed_by: invalid (${args.managed_by})`] };
    }
  }
  if (args.effective_at && Number.isNaN(Date.parse(args.effective_at))) {
    return { ok: false, errors: [`effective_at: not an ISO 8601 timestamp (${args.effective_at})`] };
  }

  let houseJson: Record<string, unknown>;
  if (args.house_brand_json) {
    houseJson = { ...args.house_brand_json };
  } else if (args.house_domain) {
    const fetched = await fetchBrandJson(normalizeDomain(args.house_domain));
    if (!fetched.ok) return { ok: false, errors: [fetched.error] };
    houseJson = { ...fetched.data };
  } else {
    return {
      ok: false,
      errors: ['Either house_brand_json or house_domain is required'],
    };
  }

  // Must be a House Portfolio (has `house` object). Reject redirects /
  // canonical docs / agent variants — adding pointer entries only makes
  // sense for a portfolio publisher.
  const houseField = houseJson.house;
  if (!houseField || typeof houseField !== 'object' || Array.isArray(houseField)) {
    return {
      ok: false,
      errors: ['house_brand_json is not a House Portfolio variant (top-level `house` object required).'],
    };
  }
  const houseDomain = (houseField as Record<string, unknown>).domain;
  if (typeof houseDomain !== 'string') {
    return { ok: false, errors: ['house.domain is required on a House Portfolio'] };
  }

  // Conformance: house_domain not in brands[] — that's a different field
  // entirely, and a leaf can't itself appear inside its own portfolio's
  // inline brands[] under its house's domain. We enforce the spec's actual
  // invariants: cross-array brand_id uniqueness + brand_refs[] domain
  // uniqueness.
  const inlineBrands = Array.isArray(houseJson.brands) ? (houseJson.brands as Array<Record<string, unknown>>) : [];
  const inlineIds = new Set(inlineBrands.map((b) => b.id).filter((id): id is string => typeof id === 'string'));
  if (inlineIds.has(args.brand_id)) {
    return {
      ok: false,
      errors: [
        `brand_id "${args.brand_id}" already appears in brands[] — a brand_id MUST NOT appear in both brands[] and brand_refs[] (cross-array uniqueness).`,
      ],
    };
  }

  const existingRefs = Array.isArray(houseJson.brand_refs)
    ? (houseJson.brand_refs as Array<Record<string, unknown>>).slice()
    : [];

  for (const entry of existingRefs) {
    if (typeof entry.domain === 'string' && normalizeDomain(entry.domain) === childDomain) {
      return {
        ok: false,
        errors: [
          `brand_refs[] already has an entry for domain "${childDomain}" — each domain MUST be unique within brand_refs[].`,
        ],
      };
    }
    if (typeof entry.brand_id === 'string' && entry.brand_id === args.brand_id) {
      return {
        ok: false,
        errors: [
          `brand_refs[] already has an entry with brand_id "${args.brand_id}" — each brand_id MUST be unique within brand_refs[].`,
        ],
      };
    }
  }

  const newEntry: Record<string, unknown> = {
    domain: childDomain,
    brand_id: args.brand_id,
  };
  if (args.managed_by) newEntry.managed_by = normalizeDomain(args.managed_by);
  if (args.effective_at) newEntry.effective_at = args.effective_at;

  const updated: Record<string, unknown> = {
    ...houseJson,
    brand_refs: [...existingRefs, newEntry],
  };

  // Validate the updated document. If schema validation fails, return the
  // doc anyway alongside the errors so the operator can see what went wrong.
  const validate = getValidator();
  const valid = validate(updated);
  if (!valid) {
    return { ok: false, brand_json: updated, errors: formatAjvErrors(validate) };
  }

  return { ok: true, brand_json: updated };
}

// ─── Tool 3: check_mutual_assertion ─────────────────────────────────────────

export type TrustTier =
  | 'mutual'
  | 'leaf_only'
  | 'house_only'
  | 'standalone'
  | 'unverifiable';

export interface CheckMutualAssertionResult {
  tier: TrustTier;
  leaf_domain: string;
  leaf_house_domain?: string;
  resolved_house_domain?: string;
  redirect_chain?: string[];
  leaf_brand_id?: string;
  house_contact_email?: string;
  errors?: string[];
}

const MAX_REDIRECT_HOPS = 3;

/**
 * Resolve a House Portfolio document by following House Redirects on the
 * house side. Returns the terminal House Portfolio plus the redirect chain
 * traversed (always includes the starting domain). Caps at MAX_REDIRECT_HOPS
 * per the spec.
 */
async function resolveHousePortfolio(
  startingDomain: string,
): Promise<
  | { ok: true; portfolio: Record<string, unknown>; chain: string[]; finalDomain: string }
  | { ok: false; chain: string[]; error: string }
> {
  const chain: string[] = [];
  let current = startingDomain;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    chain.push(current);
    const fetched = await fetchBrandJson(current);
    if (!fetched.ok) {
      return { ok: false, chain, error: fetched.error };
    }
    const data = fetched.data;

    // Authoritative location redirect — rare on the house side; treat as a redirect.
    if (typeof data.authoritative_location === 'string') {
      if (hop === MAX_REDIRECT_HOPS) {
        return { ok: false, chain, error: 'Exceeded 3-hop redirect limit' };
      }
      try {
        const url = new URL(data.authoritative_location);
        current = url.hostname.toLowerCase();
        continue;
      } catch {
        return { ok: false, chain, error: 'authoritative_location is not a valid URL' };
      }
    }

    // House Redirect — variant 2 with `house` as a string pointing to the canonical house.
    if (typeof data.house === 'string') {
      if (hop === MAX_REDIRECT_HOPS) {
        return { ok: false, chain, error: 'Exceeded 3-hop redirect limit' };
      }
      current = normalizeDomain(data.house);
      continue;
    }

    // House Portfolio — `house` is an object.
    if (data.house && typeof data.house === 'object' && !Array.isArray(data.house)) {
      return { ok: true, portfolio: data, chain, finalDomain: current };
    }

    return {
      ok: false,
      chain,
      error: `Document at ${current} is not a House Portfolio or House Redirect`,
    };
  }

  return { ok: false, chain, error: 'Exceeded 3-hop redirect limit' };
}

export async function checkMutualAssertion(
  leafDomainRaw: string,
): Promise<CheckMutualAssertionResult> {
  const leafDomain = normalizeDomain(leafDomainRaw);
  if (!DOMAIN_PATTERN.test(leafDomain)) {
    return {
      tier: 'unverifiable',
      leaf_domain: leafDomain,
      errors: [`leaf domain invalid: ${leafDomainRaw}`],
    };
  }

  // 1. Fetch the leaf's canonical document.
  const leafFetch = await fetchBrandJson(leafDomain);
  if (!leafFetch.ok) {
    return {
      tier: 'unverifiable',
      leaf_domain: leafDomain,
      errors: [`leaf: ${leafFetch.error}`],
    };
  }
  const leafDoc = leafFetch.data;

  // Confirm this looks like a canonical document — must have top-level `id` + `names`
  // and must not be a portfolio (no `house`). We're permissive here: if the
  // document has `house_domain` we treat it as a canonical doc regardless.
  const leafBrandId = typeof leafDoc.id === 'string' ? leafDoc.id : undefined;
  const leafHouseDomainRaw = typeof leafDoc.house_domain === 'string' ? leafDoc.house_domain : undefined;

  // Standalone — leaf claims no house. Per Conformance, this trumps any
  // third-party claim. Don't even fetch the house side.
  if (!leafHouseDomainRaw) {
    return {
      tier: 'standalone',
      leaf_domain: leafDomain,
      leaf_brand_id: leafBrandId,
    };
  }

  const leafHouseDomain = normalizeDomain(leafHouseDomainRaw);

  // 2. Resolve the house side, following House Redirects.
  const houseResolution = await resolveHousePortfolio(leafHouseDomain);
  if (!houseResolution.ok) {
    return {
      tier: 'unverifiable',
      leaf_domain: leafDomain,
      leaf_brand_id: leafBrandId,
      leaf_house_domain: leafHouseDomain,
      redirect_chain: houseResolution.chain,
      errors: [`house: ${houseResolution.error}`],
    };
  }

  const housePortfolio = houseResolution.portfolio;
  const houseContact = housePortfolio.contact;
  const houseContactEmail =
    houseContact && typeof houseContact === 'object' && !Array.isArray(houseContact)
      ? (houseContact as Record<string, unknown>).email
      : undefined;

  // 3. Check brand_refs[] for the leaf.
  const brandRefs = Array.isArray(housePortfolio.brand_refs)
    ? (housePortfolio.brand_refs as Array<Record<string, unknown>>)
    : [];
  const matched = brandRefs.find((entry) => {
    if (typeof entry.domain !== 'string') return false;
    return normalizeDomain(entry.domain) === leafDomain;
  });

  if (matched) {
    return {
      tier: 'mutual',
      leaf_domain: leafDomain,
      leaf_brand_id: leafBrandId,
      leaf_house_domain: leafHouseDomain,
      resolved_house_domain: houseResolution.finalDomain,
      redirect_chain: houseResolution.chain,
      house_contact_email: typeof houseContactEmail === 'string' ? houseContactEmail : undefined,
    };
  }

  // 4. House silent on this leaf.
  return {
    tier: 'leaf_only',
    leaf_domain: leafDomain,
    leaf_brand_id: leafBrandId,
    leaf_house_domain: leafHouseDomain,
    resolved_house_domain: houseResolution.finalDomain,
    redirect_chain: houseResolution.chain,
    house_contact_email: typeof houseContactEmail === 'string' ? houseContactEmail : undefined,
  };
}

// ─── Tool 4: notify_pending_verification ────────────────────────────────────

/** 24h cooldown per {leaf, house} pair. */
const NOTIFICATION_COOLDOWN_HOURS = 24;

/** Feature flag — defaults to log-only so the new send surface is opt-in. */
const EMAIL_ENABLED = process.env.BRAND_ASSERTION_EMAIL_ENABLED === 'true';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY && EMAIL_ENABLED ? new Resend(RESEND_API_KEY) : null;

const FROM_EMAIL =
  process.env.BRAND_ASSERTION_FROM_EMAIL ??
  'AgenticAdvertising.org <hello@updates.agenticadvertising.org>';

export interface NotifyPendingVerificationArgs {
  leaf_domain: string;
  house_domain: string;
  house_contact_email: string;
  leaf_brand_id?: string;
}

export interface NotifyPendingVerificationResult {
  ok: boolean;
  sent: boolean;
  reason?: 'sent' | 'rate_limited' | 'log_only' | 'no_resend' | 'invalid_email';
  next_eligible_at?: string;
  message_preview?: string;
  errors?: string[];
}

/**
 * Check (and atomically claim) the rate-limit slot for a {leaf, house} pair.
 * Uses ON CONFLICT to make the check + reservation a single statement so two
 * concurrent notifications can't both clear the cooldown.
 */
async function claimNotificationSlot(
  leafDomain: string,
  houseDomain: string,
): Promise<{ allowed: true } | { allowed: false; nextEligibleAt: Date }> {
  const cooldownMs = NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000;
  const now = new Date();

  // Insert or update only when the existing row is older than the cooldown.
  // The RETURNING + xmax trick tells us whether we inserted or updated.
  const result = await query<{ last_notified_at: Date; inserted: boolean }>(
    `
    INSERT INTO brand_assertion_notifications (leaf_domain, house_domain, last_notified_at, notification_count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (leaf_domain, house_domain) DO UPDATE
      SET last_notified_at = EXCLUDED.last_notified_at,
          notification_count = brand_assertion_notifications.notification_count + 1
      WHERE brand_assertion_notifications.last_notified_at < $4
    RETURNING last_notified_at, (xmax = 0) AS inserted
    `,
    [leafDomain, houseDomain, now, new Date(now.getTime() - cooldownMs)],
  );

  if (result.rowCount === 0) {
    // Row exists and we did not update it — fetch the prior timestamp.
    const existing = await query<{ last_notified_at: Date }>(
      `SELECT last_notified_at FROM brand_assertion_notifications WHERE leaf_domain = $1 AND house_domain = $2`,
      [leafDomain, houseDomain],
    );
    const last = existing.rows[0]?.last_notified_at ?? now;
    return {
      allowed: false,
      nextEligibleAt: new Date(new Date(last).getTime() + cooldownMs),
    };
  }

  return { allowed: true };
}

function buildNotificationEmail(args: NotifyPendingVerificationArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `[AdCP] ${args.leaf_domain} is claiming reciprocation in your brand portfolio`;
  const brandIdLine = args.leaf_brand_id
    ? `Claimed brand_id: ${args.leaf_brand_id}\n`
    : '';
  const text = `Hello ${args.house_domain} brand team,

The brand at ${args.leaf_domain} has published a brand.json declaring
house_domain: "${args.house_domain}". For mutual-assertion trust under
AdCP's distributed brand.json spec, your brand_refs[] must include a
reciprocal entry.

${brandIdLine}Until you add the entry, the leaf's identity (logos, colors, tone) is
still trusted on its own TLS, but governance, member-feature inheritance,
and billable inclusion are blocked.

To complete reciprocation, add an entry to your House Portfolio
(/.well-known/brand.json) under brand_refs[]:

  {
    "domain": "${args.leaf_domain}",
    "brand_id": "${args.leaf_brand_id ?? '<your-brand-id-for-this-leaf>'}",
    "effective_at": "${new Date().toISOString()}"
  }

This is a one-time notification per leaf+house pair (rate-limited at one
per 24 hours). For more on the trust model, see:
https://adcontextprotocol.org/docs/brand-protocol/brand-json#mutual-assertion-trust-model

— AgenticAdvertising.org
`;

  const html = `<p>Hello ${args.house_domain} brand team,</p>
<p>The brand at <code>${args.leaf_domain}</code> has published a
<code>brand.json</code> declaring <code>house_domain: "${args.house_domain}"</code>.
For mutual-assertion trust under AdCP's distributed <code>brand.json</code>
spec, your <code>brand_refs[]</code> must include a reciprocal entry.</p>
${args.leaf_brand_id ? `<p>Claimed brand_id: <code>${args.leaf_brand_id}</code></p>` : ''}
<p>Until you add the entry, the leaf's identity (logos, colors, tone) is
still trusted on its own TLS, but governance, member-feature inheritance,
and billable inclusion are blocked.</p>
<p>To complete reciprocation, add an entry to your House Portfolio
(<code>/.well-known/brand.json</code>) under <code>brand_refs[]</code>:</p>
<pre>{
  "domain": "${args.leaf_domain}",
  "brand_id": "${args.leaf_brand_id ?? '&lt;your-brand-id-for-this-leaf&gt;'}",
  "effective_at": "${new Date().toISOString()}"
}</pre>
<p>This is a one-time notification per leaf+house pair (rate-limited at
one per 24 hours). For more on the trust model, see
<a href="https://adcontextprotocol.org/docs/brand-protocol/brand-json#mutual-assertion-trust-model">the spec</a>.</p>
<p>— AgenticAdvertising.org</p>`;

  return { subject, text, html };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function notifyPendingVerification(
  args: NotifyPendingVerificationArgs,
): Promise<NotifyPendingVerificationResult> {
  const leafDomain = normalizeDomain(args.leaf_domain);
  const houseDomain = normalizeDomain(args.house_domain);

  if (!DOMAIN_PATTERN.test(leafDomain)) {
    return { ok: false, sent: false, errors: [`leaf_domain invalid: ${args.leaf_domain}`] };
  }
  if (!DOMAIN_PATTERN.test(houseDomain)) {
    return { ok: false, sent: false, errors: [`house_domain invalid: ${args.house_domain}`] };
  }
  const email = args.house_contact_email.trim();
  if (!EMAIL_PATTERN.test(email)) {
    return {
      ok: false,
      sent: false,
      reason: 'invalid_email',
      errors: [`house_contact_email invalid: ${args.house_contact_email}`],
    };
  }

  // Reserve the rate-limit slot before any send so concurrent calls don't
  // double-send. If the slot is already taken, return rate-limited.
  const slot = await claimNotificationSlot(leafDomain, houseDomain);
  if (!slot.allowed) {
    return {
      ok: true,
      sent: false,
      reason: 'rate_limited',
      next_eligible_at: slot.nextEligibleAt.toISOString(),
    };
  }

  const email_body = buildNotificationEmail({
    ...args,
    leaf_domain: leafDomain,
    house_domain: houseDomain,
  });

  // Log-only mode — feature flag off (the default). Surface the would-have-sent
  // payload so operators can audit before flipping the flag in production.
  if (!EMAIL_ENABLED) {
    logger.info(
      {
        leafDomain,
        houseDomain,
        toEmail: email,
        subject: email_body.subject,
      },
      'brand-assertion notify (log-only): would send pending-verification email',
    );
    return {
      ok: true,
      sent: false,
      reason: 'log_only',
      message_preview: email_body.subject,
    };
  }

  if (!resend) {
    logger.warn({ leafDomain, houseDomain }, 'brand-assertion notify: Resend not configured');
    return {
      ok: false,
      sent: false,
      reason: 'no_resend',
      errors: ['BRAND_ASSERTION_EMAIL_ENABLED=true but RESEND_API_KEY is not set'],
    };
  }

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: email_body.subject,
      text: email_body.text,
      html: email_body.html,
    });

    if (error) {
      logger.error({ error, leafDomain, houseDomain }, 'brand-assertion notify: send failed');
      return { ok: false, sent: false, errors: [String(error)] };
    }

    return { ok: true, sent: true, reason: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, leafDomain, houseDomain }, 'brand-assertion notify: send threw');
    return { ok: false, sent: false, errors: [message] };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export const BRAND_CANONICAL_TOOLS: AddieTool[] = [
  {
    name: 'publish_brand_canonical_document',
    description:
      "Generate a Brand Canonical Document (brand.json variant 5) for a sub-brand team. Builds a JSON document with the brand's identity fields (logos/colors/tone/etc.), validates it against the brand.json schema, and returns the document plus the path where it should be hosted (https://{domain}/.well-known/brand.json). Returns validation errors instead of an invalid document. Does NOT upload — the operator hosts the returned JSON themselves.",
    usage_hints:
      "Use when a brand team wants to self-publish their identity at their own /.well-known/brand.json. Optionally takes a house_domain pointer up to a corporate house. After generation, suggest the user also call add_to_brand_refs on the house portfolio to complete the mutual-assertion edge.",
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: "Brand's primary domain (where /.well-known/brand.json will be hosted).",
        },
        brand_id: {
          type: 'string',
          description:
            "Stable brand identifier (lowercase alphanumeric with underscores). Should match the brand_id the house uses in its brand_refs[] entry.",
        },
        names: {
          type: 'array',
          description:
            "Localized brand names. Each item is an object with one locale key, e.g. {\"en_US\": \"Converse\"}.",
          items: { type: 'object' },
        },
        house_domain: {
          type: 'string',
          description:
            "Optional pointer to the corporate house this brand belongs to. Omit for standalone brands. Mutual-assertion trust requires the named house's brand_refs[] to reciprocate.",
        },
        keller_type: {
          type: 'string',
          enum: ['master', 'sub_brand', 'endorsed', 'independent'],
          description: 'Brand architecture classification (Keller).',
        },
        parent_brand: { type: 'string', description: 'Parent brand_id for sub-brands/endorsed brands.' },
        tagline: { type: 'string', description: 'Brand tagline/slogan.' },
        description: { type: 'string', description: 'Free-text brand description.' },
        industries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Industry classifications.',
        },
        logos: {
          type: 'array',
          description: 'Brand logo assets — array of objects with url (required), variant, tags, etc.',
        },
        colors: {
          type: 'object',
          description: 'Brand color palette (primary/secondary/accent/... — hex values).',
        },
        fonts: { type: 'object', description: 'Brand typography roles.' },
        tone: { type: 'object', description: 'Brand voice / dos / donts.' },
        visual_guidelines: { type: 'object', description: 'Visual-system rules for generative creative.' },
        trademarks: {
          type: 'array',
          description: 'Brand-level registered trademarks. Each: { registry, number, mark, ... }.',
        },
        properties: {
          type: 'array',
          description: 'Digital properties (websites, apps) owned/operated by this brand.',
        },
        contact: { type: 'object', description: 'Brand contact info.' },
        brand_agent: { type: 'object', description: 'Brand agent { url, id } — overrides identity fields when present.' },
        rights_agent: { type: 'object', description: 'Rights agent for licensing { url, id, available_uses, ... }.' },
        version: { type: 'string', description: "Document version. Defaults to '1.0'." },
        last_updated: { type: 'string', description: 'ISO 8601 timestamp.' },
        extra: {
          type: 'object',
          description:
            'Advanced: additional canonical-doc top-level fields not covered by the named parameters above. Only spec-allowed keys are kept; everything else is silently dropped.',
        },
      },
      required: ['domain', 'brand_id', 'names'],
    },
  },
  {
    name: 'add_to_brand_refs',
    description:
      "Append a portfolio_entry pointer to a House Portfolio's brand_refs[]. Either pass the house's brand.json directly (house_brand_json) or have the tool fetch it (house_domain). Enforces the cross-array uniqueness invariants from the spec: a brand_id MUST NOT appear in both brands[] and brand_refs[], and each brand_id/domain MUST be unique within brand_refs[]. Returns the updated brand.json or a clear validation error.",
    usage_hints:
      "Use when a house portfolio operator wants to add a child brand that publishes its own canonical document. Pair with publish_brand_canonical_document on the child side to complete the mutual-assertion edge.",
    input_schema: {
      type: 'object',
      properties: {
        house_brand_json: {
          type: 'object',
          description:
            "The house's current brand.json contents. Pass this when you already have the document in hand (e.g., the user pasted it). Mutually exclusive with house_domain.",
        },
        house_domain: {
          type: 'string',
          description:
            "Domain of the house. The tool fetches https://{house_domain}/.well-known/brand.json. Mutually exclusive with house_brand_json.",
        },
        child_domain: {
          type: 'string',
          description: "Where the child's canonical brand.json lives (e.g. 'converse.com').",
        },
        brand_id: {
          type: 'string',
          description:
            "Stable brand_id for the child within the house's portfolio. Must match what the child uses in its canonical document.",
        },
        managed_by: {
          type: 'string',
          description:
            "Optional domain of the entity that operationally manages this brand. House-declared. NOT a trust field — used for directory aggregation only.",
        },
        effective_at: {
          type: 'string',
          description: 'Optional ISO 8601 timestamp when the house established the ownership claim.',
        },
      },
      required: ['child_domain', 'brand_id'],
    },
  },
  {
    name: 'check_mutual_assertion',
    description:
      "Given a leaf brand's domain, fetch its canonical document and its claimed house's portfolio (following House Redirects on the house side, up to 3 hops, per the Conformance section). Classify the relationship trust into: mutual (both sides reciprocate), leaf_only (leaf claims house, house silent), house_only (house claims leaf, leaf silent — returned by checking the house if a different caller already has it), standalone (no house_domain), or unverifiable (one or both fetches failed). Returns the house's contact.email when present so the caller can pass it into notify_pending_verification on leaf_only edges.",
    usage_hints:
      "Use when a user asks 'does my brand.json connect properly to my house?' or 'is this leaf trusted by its parent?'. On a leaf_only result, the next step is usually notify_pending_verification.",
    input_schema: {
      type: 'object',
      properties: {
        leaf_domain: {
          type: 'string',
          description: "The leaf brand's domain (e.g. 'converse.com').",
        },
      },
      required: ['leaf_domain'],
    },
  },
  {
    name: 'notify_pending_verification',
    description:
      "Send the SHOULD-level notification email to the house's contact.email when a leaf_only edge is detected. Rate-limited to one notification per {leaf, house} pair per 24 hours, persisted in the brand_assertion_notifications table so concurrent callers can't double-send. Behind a feature flag (BRAND_ASSERTION_EMAIL_ENABLED) — defaults to log-only so operators can review the would-have-sent payload before enabling the live send path.",
    usage_hints:
      "Use after check_mutual_assertion returns tier=leaf_only with a house_contact_email. Don't call without first checking — the notification text assumes the leaf is actually claiming the house.",
    input_schema: {
      type: 'object',
      properties: {
        leaf_domain: { type: 'string', description: "Leaf brand's domain." },
        house_domain: {
          type: 'string',
          description: "House's domain (the value the leaf put in house_domain).",
        },
        house_contact_email: {
          type: 'string',
          description: "House's published contact.email — pulled from the house's brand.json.",
        },
        leaf_brand_id: {
          type: 'string',
          description:
            "Optional: the brand_id the leaf used in its canonical document. Included in the email so the house team knows which slot to reserve.",
        },
      },
      required: ['leaf_domain', 'house_domain', 'house_contact_email'],
    },
  },
];

// ─── Handler factory ────────────────────────────────────────────────────────

export function createBrandCanonicalToolHandlers(): Map<
  string,
  (args: Record<string, unknown>) => Promise<string>
> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  handlers.set('publish_brand_canonical_document', async (args) => {
    if (typeof args.domain !== 'string' || args.domain.trim().length === 0) {
      return errorJson('domain is required');
    }
    if (typeof args.brand_id !== 'string' || args.brand_id.trim().length === 0) {
      return errorJson('brand_id is required');
    }
    if (!Array.isArray(args.names) || args.names.length === 0) {
      return errorJson('names must be a non-empty array of localized name objects');
    }

    const result = publishBrandCanonicalDocument({
      domain: args.domain,
      brand_id: args.brand_id,
      names: args.names as Array<Record<string, string>>,
      house_domain: typeof args.house_domain === 'string' ? args.house_domain : undefined,
      keller_type: args.keller_type as PublishCanonicalArgs['keller_type'],
      parent_brand: typeof args.parent_brand === 'string' ? args.parent_brand : undefined,
      logos: Array.isArray(args.logos) ? args.logos : undefined,
      colors: args.colors as Record<string, unknown> | undefined,
      fonts: args.fonts as Record<string, unknown> | undefined,
      tone: args.tone as Record<string, unknown> | undefined,
      tagline: typeof args.tagline === 'string' ? args.tagline : undefined,
      visual_guidelines: args.visual_guidelines as Record<string, unknown> | undefined,
      trademarks: Array.isArray(args.trademarks) ? args.trademarks : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
      industries: Array.isArray(args.industries) ? (args.industries as string[]) : undefined,
      contact: args.contact as Record<string, unknown> | undefined,
      properties: Array.isArray(args.properties) ? args.properties : undefined,
      brand_agent: args.brand_agent as Record<string, unknown> | undefined,
      rights_agent: args.rights_agent as Record<string, unknown> | undefined,
      version: typeof args.version === 'string' ? args.version : undefined,
      last_updated: typeof args.last_updated === 'string' ? args.last_updated : undefined,
      extra: args.extra as Record<string, unknown> | undefined,
    });

    if (!result.ok) {
      return JSON.stringify(
        {
          error: 'validation_failed',
          errors: result.errors,
          document: result.document,
          hint: 'Fix the listed errors and call publish_brand_canonical_document again.',
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        ok: true,
        hosting_path: result.hosting_path,
        next_step:
          'Host the returned document at hosting_path. If house_domain is set, also call add_to_brand_refs on the house portfolio so the mutual-assertion edge resolves.',
        document: result.document,
      },
      null,
      2,
    );
  });

  handlers.set('add_to_brand_refs', async (args) => {
    if (typeof args.child_domain !== 'string' || args.child_domain.trim().length === 0) {
      return errorJson('child_domain is required');
    }
    if (typeof args.brand_id !== 'string' || args.brand_id.trim().length === 0) {
      return errorJson('brand_id is required');
    }
    if (!args.house_brand_json && !args.house_domain) {
      return errorJson('Either house_brand_json or house_domain is required');
    }
    if (args.house_brand_json && args.house_domain) {
      return errorJson('Pass either house_brand_json or house_domain, not both');
    }

    const result = await addToBrandRefs({
      house_brand_json: args.house_brand_json as Record<string, unknown> | undefined,
      house_domain: typeof args.house_domain === 'string' ? args.house_domain : undefined,
      child_domain: args.child_domain,
      brand_id: args.brand_id,
      managed_by: typeof args.managed_by === 'string' ? args.managed_by : undefined,
      effective_at: typeof args.effective_at === 'string' ? args.effective_at : undefined,
    });

    if (!result.ok) {
      return JSON.stringify(
        {
          error: 'validation_failed',
          errors: result.errors,
          brand_json: result.brand_json,
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        ok: true,
        next_step:
          "Publish the returned brand.json to the house's /.well-known/brand.json. If the child also publishes a canonical document with house_domain pointing back, mutual assertion resolves on next crawl.",
        brand_json: result.brand_json,
      },
      null,
      2,
    );
  });

  handlers.set('check_mutual_assertion', async (args) => {
    if (typeof args.leaf_domain !== 'string' || args.leaf_domain.trim().length === 0) {
      return errorJson('leaf_domain is required');
    }
    const result = await checkMutualAssertion(args.leaf_domain);
    return JSON.stringify(result, null, 2);
  });

  handlers.set('notify_pending_verification', async (args) => {
    if (typeof args.leaf_domain !== 'string' || args.leaf_domain.trim().length === 0) {
      return errorJson('leaf_domain is required');
    }
    if (typeof args.house_domain !== 'string' || args.house_domain.trim().length === 0) {
      return errorJson('house_domain is required');
    }
    if (
      typeof args.house_contact_email !== 'string' ||
      args.house_contact_email.trim().length === 0
    ) {
      return errorJson('house_contact_email is required');
    }
    const result = await notifyPendingVerification({
      leaf_domain: args.leaf_domain,
      house_domain: args.house_domain,
      house_contact_email: args.house_contact_email,
      leaf_brand_id: typeof args.leaf_brand_id === 'string' ? args.leaf_brand_id : undefined,
    });
    return JSON.stringify(result, null, 2);
  });

  return handlers;
}
