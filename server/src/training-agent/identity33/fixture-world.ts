/**
 * Sandbox identities for the training agent's AdCP 3.3 identity route.
 *
 * A fictional brand portfolio, two buying agencies and an impostor, each
 * publishing the documents a seller reads under the experimental Web Bot
 * Auth profile and demand-side grants:
 *
 *   - Nova Brands (house): brand.json listing Nova Motors, and a trust.json
 *     naming its own buying agent and an exclusive media-buying grant to
 *     Pinnacle Agency for Nova Motors in the US and Great Britain.
 *   - Nova Motors (child brand): brand.json naming Nova Brands as its house,
 *     and no trust.json. Its parent's record protects it.
 *   - Pinnacle Agency: lists its buying agent.
 *   - QuickMedia: lists its own buying agent and holds no grant from Nova.
 *   - Offline Brand: its trust.json is unavailable (503), for outage handling.
 *
 * The domains are placeholders on a real TLD because grant evaluation needs
 * registrable domains (`.example` is special-use and has none). They are
 * served only from this in-process map and are never fetched over the
 * network; `fixtureFetch` refuses every other host.
 *
 * The private keys are published on purpose, like the request-signing test
 * vectors: anyone can sign as these fictional agents, and they are trusted
 * only for these fictional origins on the sandbox identity route.
 */
import {
  createSignedOriginRevocationList,
  createSignedSignatureDirectory,
  type WebBotSigningKey,
} from '@adcp/sdk/identity-3.3';

export const FIXTURE_SUFFIX = '-7k3q.com';

export const FIXTURE_DOMAINS = {
  house: `nova-brands${FIXTURE_SUFFIX}`,
  child: `nova-motors${FIXTURE_SUFFIX}`,
  agency: `pinnacle-agency${FIXTURE_SUFFIX}`,
  impostor: `quickmedia${FIXTURE_SUFFIX}`,
  offline: `offline-brand${FIXTURE_SUFFIX}`,
} as const;

interface FixtureAgent {
  origin: string;
  key: { kty: 'OKP'; crv: 'Ed25519'; x: string; d: string; kid: string };
}

/** Ed25519 keys; each `kid` is the RFC 7638 thumbprint of the public key. */
export const FIXTURE_AGENTS = {
  house: {
    origin: `https://buyer.${FIXTURE_DOMAINS.house}`,
    key: {
      kty: 'OKP', crv: 'Ed25519',
      x: 'REm7I9q-BamMzI1kMZk678dtIbbp7-XmIFRWtsKneP0',
      d: 'FJ1UGfeWx7yPBrbXpdS2rGNlXHGNQA0TfPt8P4srxY0',
      kid: 'AO1nX3ugs82FPyWry1pl2nHNMfFa98wcWBMXHJT5Sio',
    },
  },
  agency: {
    origin: `https://buyer.${FIXTURE_DOMAINS.agency}`,
    key: {
      kty: 'OKP', crv: 'Ed25519',
      x: 'z9OEyZwbGUo4P9HPBd6fD3XsL-HQG7eA0M7k3kAlSg0',
      d: '9806Cs0SyBBqir5a_L-cnIDEK0fDD-NOVoBbN1Xy8_M',
      kid: 'MgcoG8r0whz1o3-WY4wxcg5QjuNBegEX5iz071o-Yzs',
    },
  },
  impostor: {
    origin: `https://buyer.${FIXTURE_DOMAINS.impostor}`,
    key: {
      kty: 'OKP', crv: 'Ed25519',
      x: 'n71zYQfW1-Z4dXSlRqkCy15QoFP9UefL14bF9oqQB0c',
      d: 'qG5ilDFHCNfazD0-2Gx5U7glYW0bv93xYWn3lM5BUZc',
      kid: 'peL-9JqnJOhuyb6lVIn03DDtQM9WFcTaUWgB6V5FpRg',
    },
  },
} as const satisfies Record<string, FixtureAgent>;

export type FixtureAgentName = keyof typeof FIXTURE_AGENTS;

export function fixtureSigningKey(name: FixtureAgentName): WebBotSigningKey {
  return { privateKey: { ...FIXTURE_AGENTS[name].key } };
}

const buying = (origin: string) => ({ url: origin, roles: ['adcp:buying'] });

const TRUST_RECORDS: Record<string, unknown> = {
  [FIXTURE_DOMAINS.house]: {
    exclusive_grants: true,
    agents: [buying(FIXTURE_AGENTS.house.origin)],
    grants: [
      {
        grantee: FIXTURE_DOMAINS.agency,
        scopes: ['adcp:media_buying'],
        agents: [{ url: FIXTURE_AGENTS.agency.origin }],
        profiles: { adcp: { brands: ['nova_motors'] } },
        countries: ['US', 'GB'],
      },
    ],
  },
  [FIXTURE_DOMAINS.agency]: { agents: [buying(FIXTURE_AGENTS.agency.origin)] },
  [FIXTURE_DOMAINS.impostor]: { agents: [buying(FIXTURE_AGENTS.impostor.origin)] },
};

/** Domains whose trust.json is unavailable rather than absent. */
const UNAVAILABLE_TRUST_RECORDS = new Set<string>([FIXTURE_DOMAINS.offline]);

const BRAND_RECORDS: Record<string, unknown> = {
  [FIXTURE_DOMAINS.house]: {
    house: { domain: FIXTURE_DOMAINS.house, name: 'Nova Brands' },
    brand_refs: [{ domain: FIXTURE_DOMAINS.child, brand_id: 'nova_motors' }],
  },
  [FIXTURE_DOMAINS.child]: {
    id: 'nova_motors',
    names: [{ en: 'Nova Motors' }],
    house_domain: FIXTURE_DOMAINS.house,
  },
};

/**
 * The house a fixture brand's brand.json names, when the house lists the
 * brand back (the mutual-assertion model), with the brand's ID in the house.
 * Undefined for a standalone or unknown brand.
 */
export function fixtureBrandHouse(brandDomain: string): { domain: string; brand_id: string } | undefined {
  const brand = BRAND_RECORDS[brandDomain.toLowerCase()] as { house_domain?: string } | undefined;
  if (!brand?.house_domain) return undefined;
  const house = BRAND_RECORDS[brand.house_domain] as
    | { brand_refs?: Array<{ domain: string; brand_id: string }> }
    | undefined;
  const ref = house?.brand_refs?.find(entry => entry.domain === brandDomain.toLowerCase());
  return ref ? { domain: brand.house_domain, brand_id: ref.brand_id } : undefined;
}

/** Every host the fixture world serves: its registrable domains and agent origins. */
const FIXTURE_HOSTS = new Set<string>([
  ...Object.values(FIXTURE_DOMAINS),
  ...Object.values(FIXTURE_AGENTS).map(agent => new URL(agent.origin).hostname),
]);

export function isFixtureDomain(domain: string): boolean {
  return FIXTURE_HOSTS.has(domain.toLowerCase());
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Serves the fixture world in-process. Key directories and revocation lists
 * are signed on request so their validity windows are always current.
 */
export const fixtureFetch: typeof fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'https:' || !isFixtureDomain(url.hostname)) {
    throw new Error('The sandbox identity route resolves only its fixture identities');
  }
  const agent = Object.values(FIXTURE_AGENTS).find(entry => entry.origin === url.origin);
  switch (url.pathname) {
    case '/.well-known/trust.json':
      if (UNAVAILABLE_TRUST_RECORDS.has(url.hostname)) return new Response('', { status: 503 });
      return url.hostname in TRUST_RECORDS ? json(TRUST_RECORDS[url.hostname]) : new Response('', { status: 404 });
    case '/.well-known/brand.json':
      return url.hostname in BRAND_RECORDS ? json(BRAND_RECORDS[url.hostname]) : new Response('', { status: 404 });
    case '/.well-known/http-message-signatures-directory': {
      if (!agent) return new Response('', { status: 404 });
      const directory = await createSignedSignatureDirectory(agent.origin, [{ privateKey: { ...agent.key } }]);
      return new Response(directory.body, {
        status: directory.status,
        headers: directory.headers as Record<string, string>,
      });
    }
    case '/.well-known/governance-revocations.json': {
      if (!agent) return new Response('', { status: 404 });
      const now = Date.now();
      const list = await createSignedOriginRevocationList(
        {
          issuer: agent.origin,
          updated: new Date(now).toISOString(),
          next_update: new Date(now + 15 * 60_000).toISOString(),
          revoked_kids: [],
        },
        { ...agent.key },
      );
      return new Response(list, { status: 200, headers: { 'content-type': 'application/jose' } });
    }
    default:
      return new Response('', { status: 404 });
  }
};
