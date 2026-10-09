/**
 * Hosted-grader buyer identity for grading governance-aware sellers (#7758).
 *
 * Hosted grading runs the multi-agent governance storyboards against a
 * third-party seller with the sandbox governance agent
 * (`https://test-agent.adcontextprotocol.org`) as the buyer's governance
 * agent. A seller verifying the signed `governance_context` needs two things
 * from the buyer (docs/building/by-layer/L1/security.mdx):
 *
 * - A buyer identity bound to the credential that calls it ("Buyer identity
 *   resolution"). Hosted grading authenticates to the sandbox governance agent
 *   as one fixed buyer agent, {@link HOSTED_GRADER_BUYER_AGENT_URL}, which the
 *   governance agent binds into every intent token as `caller`. A seller maps
 *   the credential it gives hosted grading to that buyer agent and to
 *   {@link HOSTED_GRADER_BRAND_DOMAIN}.
 * - That buyer's brand.json, listing the governance agent whose URL equals the
 *   token `iss` (checklist step 13), with a `jwks_uri` for its keys.
 *
 * The brand domain is a dedicated host. It serves only the brand.json and a
 * governance-only JWKS, so governance-signing keys are published on an origin
 * that serves no RFC 9421 request- or webhook-signing keys (security.mdx,
 * "Origin separation"). Every other host of this app publishes Addie's
 * request-signing JWKS at `/.well-known/jwks.json`.
 *
 * Sandbox only: the governance signing key is public test material
 * (governance-signing.ts), so anyone can mint a token that passes these checks
 * for this brand. Sellers trust this brand only for their hosted-grading
 * sandbox accounts.
 */

import { Router, type Request, type Response } from 'express';
import { getTrainingGovernanceIssuer } from './canonical-base.js';
import { getGovernanceSigningPublicJwk } from './governance-signing.js';

export const HOSTED_GRADER_HOSTNAME = 'hosted-grader.adcontextprotocol.org';
export const HOSTED_GRADER_ORIGIN = `https://${HOSTED_GRADER_HOSTNAME}`;
/** Buyer brand the governance storyboards name (test-kits/hosted-grader.yaml). */
export const HOSTED_GRADER_BRAND_DOMAIN = HOSTED_GRADER_HOSTNAME;
/**
 * The buyer agent hosted grading authenticates as on the sandbox governance
 * agent, and the intent token `caller`. Compared byte-for-byte: no trailing
 * slash, lowercase host, no port.
 */
export const HOSTED_GRADER_BUYER_AGENT_URL = `${HOSTED_GRADER_ORIGIN}/buyer`;

export interface HostedGraderBrandJsonOptions {
  /** Origin serving the brand.json and JWKS. Tests and local stand-ins only. */
  origin?: string;
}

/** The hosted-grader brand's `/.well-known/brand.json` (Brand Canonical Document). */
export function hostedGraderBrandJson(options: HostedGraderBrandJsonOptions = {}): Record<string, unknown> {
  const origin = (options.origin ?? HOSTED_GRADER_ORIGIN).replace(/\/+$/, '');
  return {
    $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
    version: '1.0',
    id: 'hosted_grader',
    names: [{ en: 'Hosted grader test brand' }],
    keller_type: 'master',
    description:
      'Sandbox buyer brand used by AgenticAdvertising.org hosted grading of governance-aware sellers. '
      + 'Its governance signing key is public test material: trust it only for hosted-grading sandbox accounts.',
    agents: [
      {
        type: 'governance',
        id: 'sandbox_governance',
        // Byte-for-byte the `iss` of every token the sandbox governance agent signs.
        url: getTrainingGovernanceIssuer(),
        jwks_uri: `${origin}/.well-known/jwks.json`,
        description: 'AdCP sandbox governance agent (public test agent). Sandbox trust only.',
      },
      {
        type: 'buying',
        id: 'hosted_grader',
        url: HOSTED_GRADER_BUYER_AGENT_URL,
        description: 'AgenticAdvertising.org hosted grader. Sellers map the credential they give hosted grading to this buyer agent.',
      },
    ],
  };
}

/** Governance-signing keys only. Never request, webhook, or TMP keys. */
export function hostedGraderGovernanceJwks(): { keys: unknown[] } {
  return { keys: [getGovernanceSigningPublicJwk()] };
}

/**
 * Router for the hosted-grader host. Mount it before any app-wide route so
 * nothing else (Addie's JWKS, the site) is served on this origin.
 */
export function createHostedGraderHostRouter(): Router {
  const router = Router();
  router.get('/.well-known/brand.json', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(hostedGraderBrandJson());
  });
  router.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(hostedGraderGovernanceJwks());
  });
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });
  return router;
}
