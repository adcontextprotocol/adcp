import { AuthenticationRequiredError } from '@adcp/sdk';
import type { AgentContextDatabase } from '../../db/agent-context-db.js';
import { isOAuthRequiredErrorMessage } from './oauth-error-detection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('agent-oauth-prompt');

function getBaseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const port = process.env.PORT || process.env.CONDUCTOR_PORT || '3000';
  return `http://localhost:${port}`;
}

export interface OAuthPromptOptions {
  /** AdCP task name for auto-retry after authorization (e.g. 'get_products'). */
  pendingTask?: string;
  /** AdCP task params for auto-retry after authorization. */
  pendingParams?: Record<string, unknown>;
  /** Where to land the user after a successful authorization. */
  returnTo?: string;
}

/**
 * Build the `/api/oauth/agent/start` URL for an agent that demands OAuth.
 * Creates the `agent_contexts` row when one doesn't exist.
 *
 * Returns null when the caller can't initiate a flow (no organization, or
 * the agent_contexts setup failed). The caller should fall back to a plain
 * "auth required" message in that case.
 */
export async function buildAgentOAuthAuthorizeUrl(
  agentUrl: string,
  organizationId: string | undefined,
  agentContextDb: AgentContextDatabase,
  options: OAuthPromptOptions = {},
): Promise<string | null> {
  if (!organizationId) return null;
  try {
    const parsed = new URL(agentUrl);
    let agentContext = await agentContextDb.getByOrgAndUrl(organizationId, agentUrl);
    if (!agentContext) {
      agentContext = await agentContextDb.create({
        organization_id: organizationId,
        agent_url: agentUrl,
        agent_name: parsed.hostname,
        agent_type: 'unknown',
        protocol: 'mcp',
      });
      logger.info({ agentUrl, agentContextId: agentContext.id }, 'Created agent context for OAuth');
    }

    const params = new URLSearchParams({ agent_context_id: agentContext.id });
    if (options.pendingTask) {
      params.set('pending_task', options.pendingTask);
      // PII in this URL leaks to browser history, the IdP referer, and any
      // HTTP access log between the user's browser and our redirect target.
      // AdCP's `BusinessEntity` carries tax_id, vat_id, registration_number,
      // and contacts on the entity itself (not nested under `.bank`), so
      // drop the whole `billing_entity` and `invoice_recipient` objects
      // rather than blacklisting individual fields. The post-OAuth replay
      // path can re-fetch these from server-side state when needed.
      const safe = options.pendingParams ? structuredClone(options.pendingParams) : {};
      delete (safe as Record<string, unknown>).billing_entity;
      delete (safe as Record<string, unknown>).invoice_recipient;
      params.set('pending_params', JSON.stringify(safe));
    }
    if (options.returnTo) {
      params.set('return_to', options.returnTo);
    }

    return `${getBaseUrl()}/api/oauth/agent/start?${params.toString()}`;
  } catch (error) {
    logger.debug({ error, agentUrl }, 'Failed to build OAuth authorize URL');
    return null;
  }
}

/**
 * Recognize "this agent demands OAuth" across the shapes the SDK exposes:
 * - Typed `AuthenticationRequiredError` (which `NeedsAuthorizationError`
 *   extends). Reliable when `@adcp/sdk` is a single copy in the dep graph
 *   — verified via `npm ls @adcp/sdk --all`. Multiple copies would break
 *   `instanceof`, which is why the regex fallback below exists.
 * - `Error.message` matching the SDK's "requires OAuth authorization"
 *   phrasing or an `AUTH_REQUIRED` payload code. The testing-SDK surfaces
 *   (`comply()`, `runStoryboard()`, `runStoryboardStep()`,
 *   `testCapabilityDiscovery()`) catch their own errors inside `runStep`
 *   and preserve only `err.message` on the step result, so callers reading
 *   step errors only ever see strings.
 */
export function isOAuthRequiredError(error: unknown): boolean {
  if (error instanceof AuthenticationRequiredError) return true;
  if (error instanceof Error) return isOAuthRequiredErrorMessage(error.message);
  if (typeof error === 'string') return isOAuthRequiredErrorMessage(error);
  return false;
}
