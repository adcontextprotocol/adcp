/**
 * MCP Authentication Middleware
 *
 * Authentication required via OAuth 2.1 (WorkOS AuthKit).
 * Unauthenticated requests receive 401 with OAuth discovery metadata.
 *
 * Flow:
 * - User adds Addie to Claude Desktop or ChatGPT
 * - Client discovers auth server via /.well-known/oauth-protected-resource
 * - Client registers via WorkOS dynamic client registration (RFC 7591)
 * - User redirected to WorkOS login, gets access token
 * - Client retries with bearer token
 *
 * JWT validation via WorkOS JWKS:
 * - Token signature verification
 * - Issuer matches AuthKit
 * - Expiry (exp) and not-before (nbf) claims
 *
 * Can be disabled via MCP_AUTH_DISABLED=true for local development.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../logger.js';

const logger = createLogger('mcp-auth');

/**
 * WorkOS AuthKit configuration
 *
 * AUTHKIT_ISSUER: The AuthKit issuer URL
 *                 Defaults to AgenticAdvertising.org's AuthKit domain
 *
 * MCP_RESOURCE_ID: Optional resource identifier for audience validation.
 *                  WorkOS MCP tokens use issuer validation only by default.
 *                  Set this only if you need strict audience checking.
 */
export const AUTHKIT_ISSUER = process.env.AUTHKIT_ISSUER || 'https://clean-gradient-46.authkit.app';
const MCP_RESOURCE_ID = process.env.MCP_RESOURCE_ID;

/**
 * Whether MCP auth is enabled
 * Can be disabled via MCP_AUTH_DISABLED=true for local development
 */
export const MCP_AUTH_ENABLED = process.env.MCP_AUTH_DISABLED !== 'true';

/**
 * JWKS (JSON Web Key Set) for token verification
 * Cached and refreshed automatically by jose library
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwks && MCP_AUTH_ENABLED) {
    const jwksUrl = new URL(`${AUTHKIT_ISSUER}/oauth2/jwks`);
    jwks = createRemoteJWKSet(jwksUrl);
    logger.info({ jwksUrl: jwksUrl.toString() }, 'MCP Auth: JWKS configured');
  }
  return jwks;
}

/**
 * Claims extracted from validated JWT
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
 * Express request with MCP auth context
 */
export interface MCPAuthenticatedRequest extends Request {
  mcpAuth?: MCPAuthContext;
}

/**
 * Extract bearer token from Authorization header
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Validate JWT and extract claims
 *
 * Per MCP auth spec:
 * - Verify signature via JWKS
 * - Check issuer matches AuthKit
 * - Validate exp/nbf claims (handled by jose library)
 * - Optionally check audience matches resource identifier
 */
async function validateToken(token: string): Promise<MCPAuthContext> {
  const jwksInstance = getJWKS();
  if (!jwksInstance) {
    throw new Error('JWKS not configured');
  }

  // Build verification options
  const verifyOptions: { issuer: string; audience?: string } = {
    issuer: AUTHKIT_ISSUER,
  };

  // Only validate audience if MCP_RESOURCE_ID is configured
  if (MCP_RESOURCE_ID) {
    verifyOptions.audience = MCP_RESOURCE_ID;
  }

  const { payload } = await jwtVerify(token, jwksInstance, verifyOptions);

  // Determine if this is M2M based on grant type or subject format
  // M2M tokens typically have grant_type: client_credentials
  // or the subject starts with 'client_'
  const isM2M = payload.grant_type === 'client_credentials' ||
    (typeof payload.sub === 'string' && payload.sub.startsWith('client_'));

  return {
    sub: payload.sub as string,
    orgId: payload.org_id as string | undefined,
    isM2M,
    email: payload.email as string | undefined,
    payload,
  };
}

/**
 * MCP authentication middleware
 *
 * Validates bearer token and attaches auth context to request.
 * Returns 401 if token is missing or invalid.
 *
 * Usage:
 * ```typescript
 * app.post('/mcp', mcpAuthMiddleware, handleMCPRequest);
 * ```
 */
export async function mcpAuthMiddleware(
  req: MCPAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Skip auth if not enabled (development mode)
  if (!MCP_AUTH_ENABLED) {
    logger.debug('MCP Auth: Disabled, skipping authentication');
    req.mcpAuth = {
      sub: 'anonymous',
      isM2M: false,
      payload: {},
    };
    next();
    return;
  }

  const token = extractBearerToken(req);

  if (!token) {
    logger.debug('MCP Auth: No bearer token provided');

    // Return WWW-Authenticate header per RFC 6750 / MCP spec
    // Omit error code when token is simply missing (per RFC 6750 Section 3.1)
    const metadataUrl = getResourceMetadataUrl(req);
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Authentication required. Provide a bearer token.',
      },
    });
    return;
  }

  try {
    const authContext = await validateToken(token);
    req.mcpAuth = authContext;

    logger.debug({
      sub: authContext.sub,
      orgId: authContext.orgId,
      isM2M: authContext.isM2M,
    }, 'MCP Auth: Token validated');

    next();
  } catch (error) {
    logger.warn({ error }, 'MCP Auth: Token validation failed');

    const metadataUrl = getResourceMetadataUrl(req);
    res.setHeader('WWW-Authenticate',
      `Bearer error="invalid_token", error_description="Invalid or expired token", resource_metadata="${metadataUrl}"`
    );
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Invalid or expired token.',
      },
    });
  }
}

/**
 * Get the resource metadata URL for this server
 */
function getResourceMetadataUrl(req: Request): string {
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  return `${protocol}://${host}/.well-known/oauth-protected-resource`;
}

/**
 * OAuth Protected Resource Metadata
 *
 * Per RFC 8707 and MCP spec, this endpoint tells clients where to authenticate.
 * MCP clients use this to discover the authorization server.
 */
export function getOAuthProtectedResourceMetadata(req: Request) {
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  const baseUrl = `${protocol}://${host}`;

  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [AUTHKIT_ISSUER],
    bearer_methods_supported: ['header'],
  };
}

