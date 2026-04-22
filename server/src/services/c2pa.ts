/**
 * C2PA provenance signing for AAO-generated imagery.
 *
 * Issues #2370: embed a signed C2PA manifest in every AI-generated image AAO
 * ships (member portraits, hero illustrations, docs storyboards) so that EU AI
 * Act Art 50 and CA SB 942 machine-readable provenance requirements are met
 * and AAO holds itself to the same standard AdCP 3.0 Governance asks of buyers.
 *
 * The cert/key are operator-provisioned — see scripts/generate-c2pa-cert.sh.
 * AAO self-signs today; CAI trust-list inclusion is a follow-up.
 */

import { Buffer } from 'buffer';
import { createHash, randomUUID } from 'crypto';
import { Builder, LocalSigner, type SettingsContext } from '@contentauth/c2pa-node';
import { createLogger } from '../logger.js';

const logger = createLogger('c2pa');

/** IPTC digital source type for AI-generated content. Required by Art 50 / SB 942. */
const AI_DIGITAL_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

/** AAO vendor prefix for custom assertion labels. */
const AAO_ASSERTION_LABEL = 'org.agenticadvertising.generation';

/**
 * Version of the AAO signing tool itself (this helper), surfaced in the manifest's
 * claim_generator_info. Bump when the assertion shape changes so downstream
 * verifiers can tell signed-with-v1 manifests apart from later revisions.
 */
const AAO_TOOL_VERSION = '1.0.0';

// AAO is the issuer and the signer — a verifier that wants to check the chain
// already knows our cert, so skip the post-sign verify against the trust list
// (which would fail for any self-signed cert not already installed as an anchor).
const BUILDER_SETTINGS: SettingsContext = {
  verify: { verifyAfterSign: false },
  trust: { verifyTrustList: false },
};

let cachedSigner: LocalSigner | null = null;
let misconfigWarned = false;

/**
 * True when signing is wired in and the cert/key secrets are present. Callers
 * must gate every signC2PA call on this — the helper throws on missing secrets.
 *
 * Logs a one-shot warning if the feature flag is on but either secret is
 * missing, so a misconfigured deploy surfaces rather than silently running
 * unsigned.
 */
export function isC2PASigningEnabled(): boolean {
  if (process.env.C2PA_SIGNING_ENABLED !== 'true') return false;
  const certPresent =
    typeof process.env.C2PA_CERT_PEM_B64 === 'string' && process.env.C2PA_CERT_PEM_B64.length > 0;
  const keyPresent =
    typeof process.env.C2PA_PRIVATE_KEY_PEM_B64 === 'string' &&
    process.env.C2PA_PRIVATE_KEY_PEM_B64.length > 0;
  if ((!certPresent || !keyPresent) && !misconfigWarned) {
    misconfigWarned = true;
    logger.warn(
      { certPresent, keyPresent },
      'C2PA_SIGNING_ENABLED is true but cert/key secret is missing — signing will be skipped',
    );
  }
  return certPresent && keyPresent;
}

function getSigner(): LocalSigner {
  if (cachedSigner) return cachedSigner;
  const certB64 = process.env.C2PA_CERT_PEM_B64;
  const keyB64 = process.env.C2PA_PRIVATE_KEY_PEM_B64;
  if (!certB64 || !keyB64) {
    throw new Error('C2PA_CERT_PEM_B64 and C2PA_PRIVATE_KEY_PEM_B64 must be set');
  }
  const certBuf = Buffer.from(certB64, 'base64');
  const keyBuf = Buffer.from(keyB64, 'base64');
  const tsaUrl = process.env.C2PA_TSA_URL || undefined;
  cachedSigner = LocalSigner.newSigner(certBuf, keyBuf, 'es256', tsaUrl);
  return cachedSigner;
}

/** Clears the cached signer. Tests use this to swap keys between cases. */
export function resetC2PASignerCache(): void {
  cachedSigner = null;
  misconfigWarned = false;
}

export interface C2PAAssertions {
  /** Name of the generator tool that produced this asset. Shown in verifier UIs. */
  claimGenerator: string;
  /** Optional human-readable title for the asset. */
  title?: string;
  /**
   * Software agent that performed the actual AI generation (e.g. Gemini model + version).
   * Version is required — verifier UIs show "unknown" as a yellow flag otherwise.
   */
  softwareAgent: { name: string; version: string };
  /**
   * Optional generator-specific attributes (vibe/palette for portraits,
   * editionDate for heroes, filename for storyboards). Stored in a custom
   * AAO assertion; do not put PII here — manifests are public.
   */
  attributes?: Record<string, string | number | boolean>;
  /**
   * MIME type of the input buffer. Defaults to image/png since every AAO
   * surface currently produces PNGs.
   */
  mimeType?: string;
}

export interface SignC2PAResult {
  /** Signed image with a JUMBF manifest embedded in an ancillary chunk. */
  signedBuffer: Buffer;
  /** SHA-256 of the embedded manifest bytes, suitable for admin lookup. */
  manifestDigest: string;
  /** Size of the embedded manifest in bytes. */
  manifestBytes: number;
}

/**
 * Sign a generated image buffer with an AAO-issued C2PA manifest. Returns the
 * signed bytes plus a digest the caller can persist for later verification.
 *
 * Synchronous: c2pa-node's Builder.sign blocks for ~50–200ms per call. Both
 * generator paths it lives behind (Gemini portrait + illustration generation)
 * already take seconds, so the added latency is in the noise.
 */
export function signC2PA(imageBuffer: Buffer, assertions: C2PAAssertions): SignC2PAResult {
  const signer = getSigner();
  const mimeType = assertions.mimeType || 'image/png';

  const builder = Builder.withJson(
    {
      claim_generator: assertions.claimGenerator,
      claim_generator_info: [
        {
          name: assertions.claimGenerator,
          version: AAO_TOOL_VERSION,
        },
      ],
      title: assertions.title,
      format: mimeType,
      instance_id: `urn:uuid:${randomUUID()}`,
      ingredients: [],
      assertions: [],
      resources: { resources: {} },
    },
    BUILDER_SETTINGS,
  );

  // Declare this asset as AI-generated. The library auto-adds a c2pa.created
  // action; we additionally emit an explicit actions assertion carrying the
  // software agent so the generator + model version is visible to verifiers.
  builder.setIntent({ create: AI_DIGITAL_SOURCE_TYPE });

  // JSON-kind assertions are passed as pre-serialized strings; CBOR-kind
  // assertions accept JS objects. We use JSON here for readability in verifier UIs.
  builder.addAssertion(
    'c2pa.actions',
    JSON.stringify({
      actions: [
        {
          action: 'c2pa.created',
          softwareAgent: assertions.softwareAgent,
          digitalSourceType: AI_DIGITAL_SOURCE_TYPE,
        },
      ],
    }),
    'Json',
  );

  if (assertions.attributes && Object.keys(assertions.attributes).length > 0) {
    builder.addAssertion(
      AAO_ASSERTION_LABEL,
      JSON.stringify({ generator_attributes: assertions.attributes }),
      'Json',
    );
  }

  const dest: { buffer: Buffer | null } = { buffer: null };
  const manifestBytes = builder.sign(
    signer,
    { buffer: imageBuffer, mimeType },
    dest,
  );

  if (!dest.buffer) {
    throw new Error('C2PA signing produced no output buffer');
  }

  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');

  logger.info(
    {
      title: assertions.title,
      generator: assertions.claimGenerator,
      softwareAgent: assertions.softwareAgent.name,
      manifestBytes: manifestBytes.length,
      digestPrefix: manifestDigest.slice(0, 16),
    },
    'C2PA manifest signed',
  );

  return {
    signedBuffer: dest.buffer,
    manifestDigest,
    manifestBytes: manifestBytes.length,
  };
}
