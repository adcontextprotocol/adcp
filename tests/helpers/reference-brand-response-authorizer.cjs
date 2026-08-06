/**
 * Reference evaluator for the AdCP 3.2 verify_brand_claim brand-authorization
 * cross-check. The fixtures are the conformance contract; this helper is one
 * executable implementation of their deterministic, post-fetch logic.
 *
 * Production verifiers still need the complete SSRF-safe brand.json/JWKS fetch
 * from the security profile. The deterministic logic below runs the shared URL
 * canonicalization vectors and binds the JWK that verified the response to the
 * unique authorized JWK by RFC 7638 thumbprint. A matching kid alone is never a
 * trust anchor.
 */

const { createHash } = require('node:crypto');

const UNRESERVED = /^[A-Za-z0-9._~-]$/;

function normalizePercentEncoding(value) {
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return null;
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => {
    const byte = Number.parseInt(hex, 16);
    const character = String.fromCharCode(byte);
    return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

function canonicalizeFixtureUrl(raw) {
  try {
    if (typeof raw !== 'string' || /\[[^\]]*%25/i.test(raw)) return null;
    const schemeSeparator = raw.indexOf('://');
    if (schemeSeparator < 0) return null;
    const authority = raw.slice(schemeSeparator + 3).split(/[/?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    if (authority.length === 0 || hostPort.length === 0 || hostPort.startsWith(':')) return null;
    const beforeFragment = raw.split('#', 1)[0];
    const hasTrailingEmptyQuery = beforeFragment.endsWith('?');
    const url = new URL(raw);
    if (!url.hostname) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.username = '';
    url.password = '';
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }

    const normalizedPath = normalizePercentEncoding(url.pathname);
    const normalizedSearch = normalizePercentEncoding(url.search);
    if (normalizedPath === null || normalizedSearch === null) return null;
    url.pathname = normalizedPath;
    url.search = normalizedSearch;
    const canonical = url.href;
    return hasTrailingEmptyQuery && !canonical.includes('?') ? `${canonical}?` : canonical;
  } catch {
    return null;
  }
}

function jwkThumbprint(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;

  let members;
  if (jwk.kty === 'OKP' && typeof jwk.crv === 'string' && typeof jwk.x === 'string') {
    members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  } else if (
    jwk.kty === 'EC'
    && typeof jwk.crv === 'string'
    && typeof jwk.x === 'string'
    && typeof jwk.y === 'string'
  ) {
    members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  } else if (jwk.kty === 'RSA' && typeof jwk.e === 'string' && typeof jwk.n === 'string') {
    members = { e: jwk.e, kty: jwk.kty, n: jwk.n };
  } else {
    return null;
  }

  return createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

function defaultJwksUri(agentUrl) {
  const url = new URL(agentUrl);
  return `${url.origin}/.well-known/jwks.json`;
}

function assessBrandResponseAuthorization(input) {
  const { agent_url: agentUrl, kid } = input.envelope || {};
  if (!input.brand_json) {
    return { trust: 'untrusted', reason: 'brand_json_unavailable' };
  }

  const canonicalAgentUrl = canonicalizeFixtureUrl(agentUrl);
  const agents = Array.isArray(input.brand_json.agents) ? input.brand_json.agents : [];
  const matches = agents.filter((agent) =>
    agent?.type === 'brand'
      && canonicalAgentUrl !== null
      && canonicalizeFixtureUrl(agent.url) === canonicalAgentUrl,
  );

  if (matches.length === 0) {
    return { trust: 'untrusted', reason: 'agent_not_authorized' };
  }
  if (matches.length > 1) {
    return { trust: 'untrusted', reason: 'agent_authorization_ambiguous' };
  }

  const jwksUri = canonicalizeFixtureUrl(matches[0].jwks_uri || defaultJwksUri(matches[0].url));
  if (jwksUri === null || !jwksUri.startsWith('https://')) {
    return { trust: 'untrusted', reason: 'jwks_unavailable', kid };
  }
  const jwks = input.jwks_by_uri?.[jwksUri];
  if (!jwks || !Array.isArray(jwks.keys)) {
    return { trust: 'untrusted', reason: 'jwks_unavailable', kid, jwks_uri: jwksUri };
  }

  const keys = jwks.keys.filter((candidate) => candidate?.kid === kid);
  if (keys.length === 0) {
    return { trust: 'untrusted', reason: 'kid_not_authorized', kid, jwks_uri: jwksUri };
  }
  if (keys.length > 1) {
    return { trust: 'untrusted', reason: 'kid_authorization_ambiguous', kid, jwks_uri: jwksUri };
  }

  const [key] = keys;
  if (key.adcp_use !== 'response-signing' || key.use !== 'sig' || !key.key_ops?.includes('verify')) {
    return { trust: 'untrusted', reason: 'key_purpose_invalid', kid, jwks_uri: jwksUri };
  }

  const verifiedThumbprint = jwkThumbprint(input.verified_jwk);
  const authorizedThumbprint = jwkThumbprint(key);
  if (
    input.verified_jwk?.kid !== kid
    || verifiedThumbprint === null
    || authorizedThumbprint === null
    || verifiedThumbprint !== authorizedThumbprint
  ) {
    return { trust: 'untrusted', reason: 'key_material_mismatch', kid, jwks_uri: jwksUri };
  }

  return { trust: 'trusted', kid, jwks_uri: jwksUri };
}

module.exports = {
  assessBrandResponseAuthorization,
  canonicalizeFixtureUrl,
  jwkThumbprint,
};
