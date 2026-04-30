/**
 * Brand property parse + merge service.
 *
 * Shared logic behind both:
 *   - POST /api/brands/:domain/properties/parse
 *   - POST /api/brands/:domain/properties
 * and Addie's parse_brand_properties / import_brand_properties tools.
 *
 * The HTTP route is a thin wrapper. The Addie tool is a thin wrapper. The
 * load-bearing defenses (DNS 253-char cap, type allowlist, lowercase, the
 * MAX_PROPERTIES cap, compression-bomb rejection on URL fetch) live here so
 * both surfaces enforce them identically.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { query } from '../db/client.js';
import { BrandDatabase } from '../db/brand-db.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { validateFetchUrl, safeFetch, sanitizeUrl } from '../utils/url-security.js';
import { ModelConfig } from '../config/models.js';

const logger = createLogger('brand-property-parse');

export const MAX_PROPERTIES = 500;
export const MAX_PARSE_INPUT_CHARS = 50_000;
export const MAX_PARSE_FETCH_BYTES = 1_000_000; // 1MB streaming cap

export const VALID_PROPERTY_TYPES = [
  'website',
  'mobile_app',
  'ctv_app',
  'desktop_app',
  'dooh',
  'podcast',
  'radio',
  'streaming_audio',
] as const;

export const VALID_RELATIONSHIPS = ['owned', 'direct', 'delegated', 'ad_network'] as const;

export type PropertyType = (typeof VALID_PROPERTY_TYPES)[number];
export type Relationship = (typeof VALID_RELATIONSHIPS)[number];

export interface ParsedProperty {
  identifier: string;
  type: PropertyType;
  relationship: Relationship;
}

export interface ParseSuccess {
  ok: true;
  properties: ParsedProperty[];
  count: number;
  truncated: boolean;
  warning?: string;
}

export interface ParseFailure {
  ok: false;
  status: number;
  error: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

/**
 * Verify the user's org owns this brand and the brand is in a valid edit
 * state (not authoritative, not orphaned). Returns the brand on success or
 * a structured failure shape.
 */
export async function getBrandForEdit(
  brandDb: BrandDatabase,
  domain: string,
  userId: string,
): Promise<
  | { ok: true; brand: NonNullable<Awaited<ReturnType<BrandDatabase['getDiscoveredBrandByDomain']>>> }
  | { ok: false; status: number; error: string }
> {
  const brand = await brandDb.getDiscoveredBrandByDomain(domain);
  if (!brand) return { ok: false, status: 404, error: 'Brand not found' };
  if (brand.source_type === 'brand_json') {
    return { ok: false, status: 409, error: 'Cannot edit self-hosted brand' };
  }
  if (brand.manifest_orphaned) {
    return {
      ok: false,
      status: 409,
      error: 'This brand is awaiting adoption — claim it through the brand identity flow first',
    };
  }

  const orgId = await resolvePrimaryOrganization(userId);
  if (!orgId) {
    return { ok: false, status: 403, error: 'No organization associated with your account' };
  }

  const orgDomains = await query<{ domain: string }>(
    'SELECT domain FROM organization_domains WHERE workos_organization_id = $1',
    [orgId],
  );
  const memberProfile = await query<{ primary_brand_domain: string | null }>(
    'SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1',
    [orgId],
  );
  const ownedDomains = new Set([
    ...orgDomains.rows.map((r) => r.domain.toLowerCase()),
    ...(memberProfile.rows[0]?.primary_brand_domain
      ? [memberProfile.rows[0].primary_brand_domain.toLowerCase()]
      : []),
  ]);
  if (!ownedDomains.has(domain.toLowerCase())) {
    return { ok: false, status: 403, error: 'You do not own this brand domain' };
  }

  return { ok: true, brand };
}

/**
 * Apply the output filter that bounds whatever the model returned: DNS 253
 * char cap, the type allowlist, lowercase trim, and MAX_PROPERTIES cap.
 *
 * This is the load-bearing defense — exposed so callers can fold an
 * already-extracted candidate list through it (Addie's import path takes
 * the user-confirmed list of identifiers and re-runs them through this).
 */
export function filterPropertyCandidates(
  candidates: Array<{ identifier?: unknown; type?: unknown }>,
  relationship: Relationship,
): ParsedProperty[] {
  const allowedTypes = new Set<string>(VALID_PROPERTY_TYPES);
  const out: ParsedProperty[] = [];
  for (const p of candidates) {
    if (
      typeof p.identifier === 'string' &&
      p.identifier.trim().length > 0 &&
      p.identifier.length <= 253 && // DNS max length
      typeof p.type === 'string' &&
      allowedTypes.has(p.type)
    ) {
      out.push({
        identifier: p.identifier.toLowerCase().trim(),
        type: p.type as PropertyType,
        relationship,
      });
    }
    if (out.length >= MAX_PROPERTIES) break;
  }
  return out;
}

/**
 * Run the LLM extraction against pasted text. No URL fetching, no auth —
 * the caller is expected to have already authenticated and (if the input
 * is a URL) fetched the body via fetchUrlForParse.
 */
export async function extractPropertiesFromText(
  rawText: string,
  relationship: Relationship,
): Promise<{ properties: ParsedProperty[]; warning?: string; userMessage: string }> {
  const userMessage = `Call extract_properties with all publisher domains and app bundle IDs found in the content below.\n\n${rawText}`;

  // Anthropic tool_use with input_schema: the model emits typed args
  // matching the schema rather than free-form text we'd have to parse.
  // This eliminates the prompt-injection surface that came with the
  // older `<content>...</content>` wrapper — a hostile URL body can
  // appear in the prompt but cannot redirect the model away from
  // calling the extraction tool with the schema-shaped output.
  const message = await getAnthropicClient().messages.create({
    model: ModelConfig.fast,
    max_tokens: 4096,
    tools: [
      {
        name: 'extract_properties',
        description:
          'Extract publisher domains and app bundle IDs from the user-supplied content. Ignore ad tech infrastructure (ad networks, DSPs, SSPs, CDNs, measurement vendors). Return an empty list if nothing matches.',
        input_schema: {
          type: 'object',
          properties: {
            properties: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  identifier: {
                    type: 'string',
                    description:
                      'Bare domain (e.g. "example.com") or app bundle ID (e.g. "com.example.app").',
                  },
                  type: { type: 'string', enum: [...VALID_PROPERTY_TYPES] },
                },
                required: ['identifier', 'type'],
              },
            },
          },
          required: ['properties'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_properties' },
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  const toolUse = message.content.find(
    (block) => block.type === 'tool_use' && block.name === 'extract_properties',
  );
  if (!toolUse || toolUse.type !== 'tool_use') {
    // tool_choice forces the tool, so this path is defensive — it only
    // fires if the model refuses (e.g. policy block) or the SDK shape
    // changes upstream.
    logger.warn('Property parse: model did not invoke the extraction tool');
    return { properties: [], warning: 'Could not parse identifiers from input', userMessage };
  }
  const parsed = toolUse.input as { properties?: Array<{ identifier?: string; type?: string }> };
  const candidates = Array.isArray(parsed.properties) ? parsed.properties : [];
  return { properties: filterPropertyCandidates(candidates, relationship), userMessage };
}

/**
 * Fetch the URL body (with SSRF + size + compression-bomb defense) and
 * return the streamed text. Return shape mirrors ParseResult so route
 * code can early-out on errors without leaking internals.
 */
export async function fetchUrlForParse(
  rawUrl: string,
): Promise<
  | { ok: true; body: string }
  | { ok: false; status: number; error: string }
> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, error: 'Invalid URL' };
  }
  // safeFetch re-validates internally; validate here first to return a clean 400
  // without revealing internal DNS error messages to the caller.
  try {
    await validateFetchUrl(parsedUrl);
  } catch {
    return { ok: false, status: 400, error: 'URL not allowed for security reasons' };
  }

  let fetchResponse;
  try {
    fetchResponse = await safeFetch(sanitizeUrl(parsedUrl), {
      // Accept-Encoding: identity disables gzip/br auto-decompression.
      // Without it, undici decodes a small encoded body into many MB
      // before the streaming byte cap can fire (compression-bomb path).
      headers: { 'User-Agent': 'AdCP Brand Builder/1.0', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Fixed string — don't echo undici/network internals to the caller.
    return { ok: false, status: 400, error: 'Could not fetch URL' };
  }
  if (!fetchResponse.ok) {
    return { ok: false, status: 400, error: `URL returned HTTP ${fetchResponse.status}` };
  }
  if (!fetchResponse.body) {
    return { ok: false, status: 400, error: 'URL returned no body' };
  }
  // Defense-in-depth for the compression-bomb path: if the server
  // ignored our Accept-Encoding: identity request and shipped gzip
  // (or br/deflate) anyway, undici auto-decodes and the byte counter
  // measures decompressed bytes — a high-ratio bomb still spikes
  // memory before the cap fires. Reject any non-identity encoding
  // outright.
  const contentEncoding = fetchResponse.headers.get('content-encoding')?.toLowerCase().trim();
  if (contentEncoding && contentEncoding !== 'identity') {
    return { ok: false, status: 400, error: 'URL response uses unsupported content-encoding' };
  }
  // Stream with a hard byte cap — Content-Length alone is not reliable for chunked responses.
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  const reader = fetchResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    chunks.push(decoder.decode(value, { stream: true }));
    if (totalBytes > MAX_PARSE_FETCH_BYTES) {
      void reader.cancel();
      break;
    }
  }
  chunks.push(decoder.decode()); // flush
  return { ok: true, body: chunks.join('') };
}

/**
 * Full parse pipeline: ownership check + (optional) URL fetch + extraction
 * + filtering. Used by the HTTP route AND by Addie's parse_brand_properties
 * tool so the contract stays identical across surfaces.
 */
export async function parsePropertyInputForBrand(args: {
  brandDb: BrandDatabase;
  domain: string;
  userId: string;
  input: string;
  inputType: 'text' | 'url';
  relationship?: Relationship;
}): Promise<ParseResult> {
  const { brandDb, domain, userId, input, inputType } = args;
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, status: 400, error: 'input required' };
  }
  if (!['text', 'url'].includes(inputType)) {
    return { ok: false, status: 400, error: "input_type must be 'text' or 'url'" };
  }
  if (args.relationship !== undefined && !VALID_RELATIONSHIPS.includes(args.relationship)) {
    return {
      ok: false,
      status: 400,
      error: `relationship must be one of: ${VALID_RELATIONSHIPS.join(', ')}`,
    };
  }
  const relationship: Relationship = args.relationship ?? 'delegated';

  // Verify brand ownership before any outbound fetch or LLM spend.
  const auth = await getBrandForEdit(brandDb, domain, userId);
  if (!auth.ok) return auth;

  let rawText = input.trim();
  let truncated = false;

  if (inputType === 'url') {
    const fetched = await fetchUrlForParse(rawText);
    if (!fetched.ok) return fetched;
    rawText = fetched.body;
  }

  if (rawText.length > MAX_PARSE_INPUT_CHARS) {
    rawText = rawText.slice(0, MAX_PARSE_INPUT_CHARS);
    truncated = true;
  }

  const { properties, warning } = await extractPropertiesFromText(rawText, relationship);
  return { ok: true, properties, count: properties.length, truncated, warning };
}

export interface MergeReport {
  added: number;
  updated: number;
  skipped: number;
  total: number;
  errors?: Array<{ row: number; error: string }>;
}

/**
 * Merge a property list into the brand's manifest by identifier. Re-runs
 * the ownership check and the type-allowlist filter — identifiers are
 * lowercased on store. Used by the HTTP route AND by Addie's
 * import_brand_properties tool.
 */
export async function mergeBrandProperties(args: {
  brandDb: BrandDatabase;
  domain: string;
  userId: string;
  properties: Array<{ identifier?: unknown; type?: unknown; relationship?: unknown; [k: string]: unknown }>;
}): Promise<{ ok: true; report: MergeReport } | { ok: false; status: number; error: string }> {
  const { brandDb, domain, userId, properties } = args;
  if (!Array.isArray(properties)) {
    return { ok: false, status: 400, error: 'properties array required' };
  }
  if (properties.length > MAX_PROPERTIES) {
    return { ok: false, status: 400, error: `Maximum ${MAX_PROPERTIES} properties per request` };
  }

  const auth = await getBrandForEdit(brandDb, domain, userId);
  if (!auth.ok) return auth;
  const brand = auth.brand;

  const manifest = (brand.brand_manifest as Record<string, unknown>) || {};
  const existing = Array.isArray(manifest.properties)
    ? (manifest.properties as Array<{ identifier: string; [k: string]: unknown }>)
    : [];

  const byIdentifier = new Map(existing.map((p) => [p.identifier, p]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ row: number; error: string }> = [];
  const allowedTypes = new Set<string>(VALID_PROPERTY_TYPES);

  for (let i = 0; i < properties.length; i++) {
    const p = properties[i];
    if (!p.identifier || typeof p.identifier !== 'string') {
      errors.push({ row: i, error: 'identifier required' });
      skipped++;
      continue;
    }
    if (p.type && (typeof p.type !== 'string' || !allowedTypes.has(p.type))) {
      errors.push({ row: i, error: `invalid type: ${String(p.type)}` });
      skipped++;
      continue;
    }

    const key = p.identifier.toLowerCase();
    if (byIdentifier.has(key)) {
      byIdentifier.set(key, { ...byIdentifier.get(key), ...p, identifier: key });
      updated++;
    } else {
      byIdentifier.set(key, { ...p, identifier: key });
      added++;
    }
  }

  manifest.properties = Array.from(byIdentifier.values());
  await query(
    'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
    [JSON.stringify(manifest), domain],
  );

  return {
    ok: true,
    report: {
      added,
      updated,
      skipped,
      total: properties.length,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}
