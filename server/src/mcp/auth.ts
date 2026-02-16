/**
 * MCP Authentication Types and Helpers
 *
 * Defines the MCPAuthContext interface used by tool handlers, and
 * provides a bridge from the SDK's AuthInfo to MCPAuthContext.
 *
 * JWT validation and OAuth proxy logic live in oauth-provider.ts.
 */

import type { JWTPayload } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Request } from 'express';

/**
 * Claims extracted from a validated JWT, used by tool handlers
 * for access control, rate limiting, and audit trails.
 */
export interface MCPAuthContext {
  /** Subject - user ID (OAuth) or client ID (M2M) */
  sub: string;
  /** Organization ID - for scoping access and rate limits */
  orgId?: string;
  /** Whether this is an M2M (machine) token vs user token */
  isM2M: boolean;
  /** User email (if OAuth flow with email scope) */
  email?: string;
  /** Raw JWT payload for additional claims */
  payload: JWTPayload;
}

/**
 * Express request with MCP auth context attached by middleware.
 */
export interface MCPAuthenticatedRequest extends Request {
  mcpAuth?: MCPAuthContext;
}

/**
 * Convert the SDK's AuthInfo (from requireBearerAuth) to MCPAuthContext.
 *
 * The verifyAccessToken function in oauth-provider.ts stashes
 * user claims in AuthInfo.extra for this bridge to extract.
 */
export function authInfoToMCPAuthContext(authInfo: AuthInfo): MCPAuthContext {
  const extra = (authInfo.extra || {}) as Record<string, unknown>;
  return {
    sub: (extra.sub as string) || 'unknown',
    orgId: extra.orgId as string | undefined,
    isM2M: (extra.isM2M as boolean) || false,
    email: extra.email as string | undefined,
    payload: (extra.payload as JWTPayload) || {},
  };
}

/**
 * Auth context for development mode (MCP_AUTH_DISABLED=true).
 */
export function anonymousAuthContext(): MCPAuthContext {
  return {
    sub: 'anonymous',
    isM2M: false,
    payload: {},
  };
}
