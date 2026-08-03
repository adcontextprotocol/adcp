/**
 * Reference evaluator for the AdCP 3.2 verify_brand_claim brand-authorization
 * cross-check. The fixtures are the conformance contract; this helper is one
 * executable implementation of their deterministic, post-fetch logic.
 *
 * Production verifiers still need the complete SSRF-safe brand.json/JWKS fetch
 * and URL canonicalization rules from the security profile. The fixture URLs
 * are ASCII HTTPS URLs without queries, dot segments, or percent encoding, so
 * the compact canonicalizer below intentionally covers only that fixture set.
 */

function canonicalizeFixtureUrl(raw) {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return url.href;
  } catch {
    return null;
  }
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

  const jwksUri = matches[0].jwks_uri || defaultJwksUri(matches[0].url);
  const jwks = input.jwks_by_uri?.[jwksUri];
  if (!jwks || !Array.isArray(jwks.keys)) {
    return { trust: 'untrusted', reason: 'jwks_unavailable', kid, jwks_uri: jwksUri };
  }

  const key = jwks.keys.find((candidate) => candidate?.kid === kid);
  if (!key) {
    return { trust: 'untrusted', reason: 'kid_not_authorized', kid, jwks_uri: jwksUri };
  }
  if (key.adcp_use !== 'response-signing' || key.use !== 'sig' || !key.key_ops?.includes('verify')) {
    return { trust: 'untrusted', reason: 'key_purpose_invalid', kid, jwks_uri: jwksUri };
  }

  return { trust: 'trusted', kid, jwks_uri: jwksUri };
}

module.exports = { assessBrandResponseAuthorization, canonicalizeFixtureUrl };
