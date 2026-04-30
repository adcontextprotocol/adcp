// Resolves schema link URLs in MDX to an env-appropriate form so contributors
// can write `/schemas/foo.json` (matching $ref convention) and still get
// working links for users in prod and a localhost preview during in-flight
// schema work. See #3634.
//
// Two consumers:
//   - lint-schema-links.mjs (commit-time, mode='prod'): bare → absolute prod.
//   - dev-docs.mjs          (dev-time, mode='dev'):    bare AND absolute prod
//                                                       → localhost/latest.
//
// Modes:
//   dev     → http://localhost:3000/schemas/latest/...
//             rewrites BOTH bare paths (legacy authored form) AND the
//             post-autofix absolute prod URL, so dev preview shows local
//             schemas during active spec work.
//   preview → no rewrite (Mintlify cloud previews resolve absolute URLs to
//             the live prod schema host on their own).
//   prod    → bare → absolute prod URL. Absolute URLs untouched. This is
//             the form that ships in committed source.
//
// Env detection: explicit `mode` option wins, otherwise MINTLIFY_PREVIEW and
// NODE_ENV, defaulting to `prod`.

import { visit } from 'unist-util-visit';

export const BARE_PREFIX = '/schemas/';
export const PROD_HOST = 'https://adcontextprotocol.org';
export const PROD_PREFIX = `${PROD_HOST}/schemas/v3/`;
export const DEV_PREFIX = 'http://localhost:3000/schemas/latest/';

export function matchSchemaUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith(PROD_PREFIX)) return { kind: 'absolute', tail: url.slice(PROD_PREFIX.length) };
  if (url.startsWith(BARE_PREFIX)) return { kind: 'bare', tail: url.slice(BARE_PREFIX.length) };
  return null;
}

export const RESOLVERS = {
  dev: (m) => `${DEV_PREFIX}${m.tail}`,
  preview: (m) => (m.kind === 'bare' ? `${PROD_PREFIX}${m.tail}` : null),
  prod: (m) => (m.kind === 'bare' ? `${PROD_PREFIX}${m.tail}` : null),
};

export function detectMode() {
  if (process.env.MINTLIFY_PREVIEW === 'true') return 'preview';
  if (process.env.NODE_ENV === 'production') return 'prod';
  if (process.env.NODE_ENV === 'development') return 'dev';
  return 'prod';
}

export function resolveSchemaUrl(url, mode = detectMode()) {
  const match = matchSchemaUrl(url);
  if (!match) return null;
  const fn = RESOLVERS[mode];
  if (!fn) throw new Error(`remark-schema-links: unknown mode "${mode}"`);
  return fn(match);
}

export default function remarkSchemaLinks(options = {}) {
  const mode = options.mode ?? detectMode();
  return (tree) => {
    visit(tree, 'link', (node) => {
      const next = resolveSchemaUrl(node.url, mode);
      if (next !== null && next !== undefined) node.url = next;
    });
  };
}
