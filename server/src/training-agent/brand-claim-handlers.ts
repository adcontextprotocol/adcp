/**
 * verify_brand_claim / verify_brand_claims handlers for the training agent.
 *
 * The headline AdCP 3.1 brand-verification surface: a consumer asks the
 * brand-agent whether a specific claim about its identity (subsidiary, parent,
 * property, trademark) is owned / pending / disputed / licensed, and the agent
 * answers with a signed envelope. Spec:
 * docs/brand-protocol/tasks/verify_brand_claim.mdx.
 *
 * The seed data is anchored to the verification-walkthrough entities
 * (Sportshaus Holdings / StreamHaus / Northwind — see
 * fixtures/verification-walkthrough/index.ts) so a learner can crawl the
 * brand.json / adagents.json chain AND ask the agent about the same
 * relationships. Responses are deterministic — built from in-memory policy,
 * not LLM calls.
 *
 * Each successful response carries a `signed_response`: a payload-envelope JWS
 * per static/schemas/source/core/response-payload-jws-envelope.json. The
 * payload is the RFC 8785/JCS canonicalization of the envelope object, signed
 * under the brand response-signing key (adcp_use: response-signing) published
 * on /.well-known/jwks.json. This is distinct from RFC 9421 transport response
 * signing — the signature rides inside the response body.
 *
 * Sandbox simplification: one brand tenant answers for several fictional
 * houses. `brand_domain` in the envelope is the resolved subject brand
 * (derived server-side from the policy match), never a caller-supplied field.
 */

import { createHash, sign as cryptoSign } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { ToolArgs, TrainingContext } from './types.js';
import { getBrandResponseSigningKey } from './brand-response-signing.js';

// ── Signed-response envelope ──────────────────────────────────────

const ENVELOPE_TYP = 'adcp-response-payload+jws';
/** Designated-task response-signing freshness window. */
const ENVELOPE_TTL_SECONDS = 3600;

type DesignatedTask = 'verify_brand_claim' | 'verify_brand_claims';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** sha256: prefix + unpadded base64url SHA-256 of the JCS canonical bytes. */
function requestHash(requestBinding: unknown): string {
  const jcs = canonicalize(requestBinding) ?? 'null';
  return `sha256:${createHash('sha256').update(jcs, 'utf8').digest('base64url')}`;
}

/**
 * Build the payload-envelope JWS. The `payload` member is the DECODED object;
 * verifiers re-canonicalize it with RFC 8785/JCS, base64url-encode it, and
 * check `signature` over `protected.payloadB64`.
 */
function signResponsePayload(args: {
  task: DesignatedTask;
  brandDomain: string;
  agentUrl: string;
  requestBinding: unknown;
  response: Record<string, unknown>;
  nowSeconds: number;
}): {
  protected: string;
  payload: Record<string, unknown>;
  signature: string;
} {
  const { kid, privateKey } = getBrandResponseSigningKey();
  const header = { alg: 'EdDSA', kid, typ: ENVELOPE_TYP };
  const protectedB64 = base64url(JSON.stringify(header));

  const payload = {
    typ: ENVELOPE_TYP,
    task: args.task,
    brand_domain: args.brandDomain,
    agent_url: args.agentUrl,
    request_hash: requestHash(args.requestBinding),
    iat: args.nowSeconds,
    exp: args.nowSeconds + ENVELOPE_TTL_SECONDS,
    response: args.response,
  };

  const payloadB64 = base64url(canonicalize(payload) ?? 'null');
  const signingInput = `${protectedB64}.${payloadB64}`;
  // Ed25519 signs with a null algorithm in node:crypto.
  const signature = base64url(cryptoSign(null, Buffer.from(signingInput, 'utf8'), privateKey));

  return { protected: protectedB64, payload, signature };
}

// ── Claim policy store (deterministic) ────────────────────────────

type VerificationStatus =
  | 'owned' | 'pending_review' | 'transferring' | 'disputed'
  | 'not_ours' | 'archived' | 'unknown' | 'licensed_in' | 'licensed_out';

interface ClaimResolution {
  /** Subject brand whose policy produced the answer — drives envelope brand_domain. */
  brand_domain: string;
  verification_status: VerificationStatus;
  /** Public-tier details (always returned when applicable). */
  details?: Record<string, unknown>;
  /** Authorized-tier details, merged into `details` only when authorized=true. */
  authorized_details?: Record<string, unknown>;
  context_note?: string;
}

const SPORTSHAUS = 'sportshaus-holdings.example';
const STREAMHAUS = 'streamhaus.example';

// subsidiary_domain → resolution (house-side: asked of Sportshaus Holdings)
const SUBSIDIARY_CLAIMS: Record<string, ClaimResolution> = {
  'streamhaus.example': {
    brand_domain: SPORTSHAUS,
    verification_status: 'owned',
    details: { brand_id: 'streamhaus' },
    authorized_details: { first_observed_by_house_at: '2025-01-01T00:00:00Z' },
  },
  'courtsidehq.example': {
    brand_domain: SPORTSHAUS,
    verification_status: 'owned',
    details: { brand_id: 'courtsidehq' },
    authorized_details: { first_observed_by_house_at: '2025-03-15T00:00:00Z' },
  },
  'newlyacquired.example': {
    brand_domain: SPORTSHAUS,
    verification_status: 'pending_review',
    // expected_resolution_window_days is REQUIRED on pending_review.
    details: { expected_resolution_window_days: 30 },
    authorized_details: { first_observed_by_house_at: '2026-06-01T00:00:00Z' },
  },
  'unaffiliated.example': {
    brand_domain: SPORTSHAUS,
    verification_status: 'not_ours',
    context_note: 'We have no record of this brand; the leaf\'s claim is in error.',
  },
};

// parent_domain → resolution (leaf-side: asked of StreamHaus)
const PARENT_CLAIMS: Record<string, ClaimResolution> = {
  'sportshaus-holdings.example': {
    brand_domain: STREAMHAUS,
    verification_status: 'owned',
    details: { house_domain: SPORTSHAUS },
    authorized_details: { first_observed_by_leaf_at: '2025-01-01T00:00:00Z' },
  },
  'nikeinc.example': {
    brand_domain: STREAMHAUS,
    verification_status: 'disputed',
    context_note: 'We are not a subsidiary of this house; their claim is in error.',
  },
};

// property identifier → resolution (asked of StreamHaus)
const PROPERTY_CLAIMS: Record<string, ClaimResolution> = {
  'streamhaus.example': {
    brand_domain: STREAMHAUS,
    verification_status: 'owned',
    details: { relationship: 'owned', brand_id: 'streamhaus', regions: ['US', 'CA'] },
    authorized_details: { use_case_authorization: { advertising: true, editorial: true } },
  },
  'fake-streamhaus.example': {
    brand_domain: STREAMHAUS,
    verification_status: 'not_ours',
    context_note: 'Unaffiliated third-party site; we do not authorize use of our marks on it.',
  },
};

interface TrademarkRecord {
  brand_domain: string;
  verification_status: VerificationStatus;
  matched_registration?: { registry: string; number: string; mark: string; registration_status: string };
  licensor_domain?: string;
  countries?: string[];
  nice_classes?: number[];
  authorized_details?: Record<string, unknown>;
  context_note?: string;
}

// mark (upper) → registry (upper) → record. A mark present under multiple
// registries with no registry filter is AMBIGUOUS_MATCH — the disambiguation
// lesson.
const TRADEMARK_CLAIMS: Record<string, Record<string, TrademarkRecord>> = {
  STREAMHAUS: {
    USPTO: {
      brand_domain: STREAMHAUS,
      verification_status: 'owned',
      matched_registration: { registry: 'USPTO', number: '7654321', mark: 'STREAMHAUS', registration_status: 'active' },
      countries: ['US'],
      nice_classes: [38, 41],
      authorized_details: { use_case_authorization: { advertising: true, merchandise_resale: false } },
    },
    EUIPO: {
      brand_domain: STREAMHAUS,
      verification_status: 'licensed_in',
      matched_registration: { registry: 'EUIPO', number: 'EU0123456', mark: 'STREAMHAUS', registration_status: 'active' },
      licensor_domain: 'streamhaus-eu-licensor.example',
      countries: ['FR', 'DE', 'IT', 'ES'],
      nice_classes: [38],
      authorized_details: { use_case_authorization: { advertising: true } },
    },
    JPO: {
      brand_domain: STREAMHAUS,
      verification_status: 'disputed',
      context_note: 'JP mark in this jurisdiction held by a separate entity; we contest their registration and do not authorize use as ours.',
    },
  },
};

// ── Claim resolution ──────────────────────────────────────────────

interface ResolveResult {
  brand_domain: string;
  body: Record<string, unknown>;
}

interface ResolveError {
  errors: Array<{ code: string; message: string; field?: string }>;
}

function isResolveError(x: ResolveResult | ResolveError): x is ResolveError {
  return (x as ResolveError).errors !== undefined;
}

function applyTier(res: ClaimResolution, authorized: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { verification_status: res.verification_status };
  const details: Record<string, unknown> = { ...(res.details ?? {}) };
  if (authorized && res.authorized_details) Object.assign(details, res.authorized_details);
  if (Object.keys(details).length > 0) body.details = details;
  if (res.context_note) body.context_note = res.context_note;
  return body;
}

const SUPPORTED_CLAIM_TYPES = ['subsidiary', 'parent', 'property', 'trademark'] as const;

interface ClaimInput {
  claim_type?: string;
  claim?: Record<string, unknown>;
}

function resolveClaim(input: ClaimInput, authorized: boolean): ResolveResult | ResolveError {
  const claimType = input.claim_type;
  const claim = input.claim ?? {};

  if (!claimType) {
    return { errors: [{ code: 'INVALID_INPUT', message: 'claim_type is required.', field: 'claim_type' }] };
  }
  if (!(SUPPORTED_CLAIM_TYPES as readonly string[]).includes(claimType)) {
    return {
      errors: [{
        code: 'UNSUPPORTED_CLAIM_TYPE',
        message: `claim_type '${claimType}' is not supported. Supported: ${SUPPORTED_CLAIM_TYPES.join(', ')}.`,
        field: 'claim_type',
      }],
    };
  }

  if (claimType === 'subsidiary') {
    const domain = String(claim.subsidiary_domain ?? '').toLowerCase();
    if (!domain) {
      return { errors: [{ code: 'INVALID_INPUT', message: 'claim.subsidiary_domain is required.', field: 'claim.subsidiary_domain' }] };
    }
    const res = SUBSIDIARY_CLAIMS[domain] ?? {
      brand_domain: SPORTSHAUS,
      verification_status: 'not_ours' as const,
      context_note: 'No record of this subsidiary in the house portfolio.',
    };
    return { brand_domain: res.brand_domain, body: { claim_type: 'subsidiary', ...applyTier(res, authorized) } };
  }

  if (claimType === 'parent') {
    const domain = String(claim.parent_domain ?? '').toLowerCase();
    if (!domain) {
      return { errors: [{ code: 'INVALID_INPUT', message: 'claim.parent_domain is required.', field: 'claim.parent_domain' }] };
    }
    const res = PARENT_CLAIMS[domain] ?? {
      brand_domain: STREAMHAUS,
      verification_status: 'disputed' as const,
      context_note: 'We do not recognize this house as our parent.',
    };
    return { brand_domain: res.brand_domain, body: { claim_type: 'parent', ...applyTier(res, authorized) } };
  }

  if (claimType === 'property') {
    const property = (claim.property ?? {}) as { identifier?: string; type?: string };
    const identifier = String(property.identifier ?? '').toLowerCase();
    if (!identifier || !property.type) {
      return { errors: [{ code: 'INVALID_INPUT', message: 'claim.property.type and claim.property.identifier are required.', field: 'claim.property' }] };
    }
    const res = PROPERTY_CLAIMS[identifier] ?? {
      brand_domain: STREAMHAUS,
      verification_status: 'not_ours' as const,
      context_note: 'This property is not part of our portfolio.',
    };
    return { brand_domain: res.brand_domain, body: { claim_type: 'property', ...applyTier(res, authorized) } };
  }

  // trademark
  const mark = String(claim.mark ?? '').toUpperCase();
  if (!mark) {
    return { errors: [{ code: 'INVALID_INPUT', message: 'claim.mark is required.', field: 'claim.mark' }] };
  }
  const byRegistry = TRADEMARK_CLAIMS[mark];
  if (!byRegistry) {
    return {
      brand_domain: STREAMHAUS,
      body: { claim_type: 'trademark', verification_status: 'not_ours', context_note: 'No registration matching this mark is held by us.' },
    };
  }
  const registry = claim.registry ? String(claim.registry).toUpperCase() : undefined;
  if (!registry) {
    const registries = Object.keys(byRegistry);
    if (registries.length > 1) {
      return {
        errors: [{
          code: 'AMBIGUOUS_MATCH',
          message: `Multiple registrations match mark '${mark}' across registries (${registries.join(', ')}). Narrow with registry, number, or countries.`,
          field: 'claim.registry',
        }],
      };
    }
  }
  const record = registry ? byRegistry[registry] : byRegistry[Object.keys(byRegistry)[0]];
  if (!record) {
    return {
      brand_domain: STREAMHAUS,
      body: { claim_type: 'trademark', verification_status: 'not_ours', context_note: `No '${mark}' registration in registry '${registry}' is held by us.` },
    };
  }
  const body: Record<string, unknown> = { claim_type: 'trademark', verification_status: record.verification_status };
  const details: Record<string, unknown> = {};
  if (record.matched_registration) details.matched_registration = record.matched_registration;
  if (record.licensor_domain) details.licensor_domain = record.licensor_domain;
  if (record.countries) details.countries = record.countries;
  if (record.nice_classes) details.nice_classes = record.nice_classes;
  if (authorized && record.authorized_details) Object.assign(details, record.authorized_details);
  if (Object.keys(details).length > 0) body.details = details;
  if (record.context_note) body.context_note = record.context_note;
  return { brand_domain: record.brand_domain, body };
}

// ── Tool handlers ─────────────────────────────────────────────────

/**
 * Build the verify_brand_claim handler bound to the responding agent URL
 * (the brand-tenant entry whose published response-signing key verifies the
 * envelope).
 */
export function verifyBrandClaimHandler(agentUrl: string) {
  return function handleVerifyBrandClaim(args: ToolArgs, ctx: TrainingContext) {
    const req = args as ClaimInput & { authorized?: boolean };
    const authorized = req.authorized === true;
    const resolved = resolveClaim(req, authorized);
    if (isResolveError(resolved)) return resolved;

    // The unsigned task body MUST equal signed_response.payload.response
    // (excluding signed_response). Fold the sandbox marker INTO the signed
    // response object so a strict verifier's field-equality check passes.
    const response = { ...resolved.body, sandbox: true };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signed = signResponsePayload({
      task: 'verify_brand_claim',
      brandDomain: resolved.brand_domain,
      agentUrl,
      // The envelope binds caller identity into request_hash (per spec) so a
      // signed answer can't be replayed across callers within the freshness
      // window. On the shared sandbox token every caller resolves to the same
      // principal, so here the binding is illustrative rather than enforced.
      requestBinding: {
        task: 'verify_brand_claim',
        caller_identity: ctx.principal ?? 'anonymous',
        claim_type: req.claim_type,
        claim: req.claim ?? {},
      },
      response,
      nowSeconds,
    });

    return { ...response, signed_response: signed };
  };
}

/**
 * Bulk variant — same per-claim semantics, one round-trip and one signature
 * over the whole `results[]` batch.
 */
export function verifyBrandClaimsHandler(agentUrl: string) {
  return function handleVerifyBrandClaims(args: ToolArgs, ctx: TrainingContext) {
    const req = args as { claims?: ClaimInput[]; authorized?: boolean };
    const claims = Array.isArray(req.claims) ? req.claims : [];
    if (claims.length === 0) {
      return { errors: [{ code: 'INVALID_INPUT', message: 'claims[] must contain at least one claim.', field: 'claims' }] };
    }
    const authorized = req.authorized === true;

    // Resolve each claim once and reuse for both results[] and brand_domain.
    // The bulk result_entry shape differs from the single-target response:
    // verify-brand-claims-response.json requires `status` on the success arm
    // (the status->verification_status rename is single-target-only), and its
    // error arm forbids both `status` and `claim_type`. So remap each success
    // body's verification_status->status, and emit error entries as { error }.
    const resolvedClaims = claims.map((c) => resolveClaim(c, authorized));
    const results = resolvedClaims.map((resolved) => {
      if (isResolveError(resolved)) {
        return { error: resolved.errors[0] };
      }
      const { verification_status, ...rest } = resolved.body as { verification_status?: unknown; [k: string]: unknown };
      return { ...rest, status: verification_status };
    });

    // brand_domain names the subject of the first successfully-resolved claim.
    // LIMITATION: a single envelope binds one brand_domain, so a mixed-subject
    // batch (claims about different brands) is attested under only the first
    // subject's domain — slightly misleading. Acceptable for the sandbox fixture;
    // a production agent would batch per-subject (or sign per-result) so each
    // answer's brand_domain matches its subject.
    const firstResolved = resolvedClaims.find((r): r is ResolveResult => !isResolveError(r));
    const brandDomain = firstResolved?.brand_domain ?? STREAMHAUS;

    const response = { results, sandbox: true };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signed = signResponsePayload({
      task: 'verify_brand_claims',
      brandDomain,
      agentUrl,
      requestBinding: {
        task: 'verify_brand_claims',
        caller_identity: ctx.principal ?? 'anonymous',
        claims,
      },
      response,
      nowSeconds,
    });

    return { ...response, signed_response: signed };
  };
}
