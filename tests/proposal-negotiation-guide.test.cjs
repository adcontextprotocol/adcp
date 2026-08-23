const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canonicalize } = require('@adcp/sdk');

const guidePath = path.join(
  __dirname,
  '..',
  'docs',
  'media-buy',
  'product-discovery',
  'proposal-negotiation.mdx'
);
const guide = fs.readFileSync(guidePath, 'utf8');
const specialistModule = fs.readFileSync(path.join(
  __dirname,
  '..',
  'docs',
  'learning',
  'specialist',
  'media-buy.mdx'
), 'utf8');
const refineProposalsReference = fs.readFileSync(path.join(
  __dirname,
  '..',
  'docs',
  'media-buy',
  'task-reference',
  'refine_proposals.mdx'
), 'utf8');

function jsonBlocks(source) {
  return [...source.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)]
    .map(match => JSON.parse(match[1]));
}

function termsDigest(commercialTerms) {
  return `sha256:${crypto.createHash('sha256')
    .update(canonicalize(commercialTerms))
    .digest('base64url')}`;
}

test('proposal negotiation guide publishes only schema-backed JSON examples', () => {
  const blocks = jsonBlocks(guide);
  assert.equal(blocks.length, 10);
  assert.ok(blocks.every(block => typeof block.$schema === 'string'));
  assert.ok(blocks.some(block => block.$schema.endsWith('/refine-proposals-request.json')));
  assert.ok(blocks.some(block => block.$schema.endsWith('/refine-proposals-response.json')));
  assert.ok(blocks.some(block => block.$schema.endsWith('/accept-proposal-request.json')));
  assert.ok(blocks.some(block => block.$schema.endsWith('/protocol-envelope.json')));
});

test('proposal examples carry recomputable RFC 8785-style terms digests', () => {
  const proposals = jsonBlocks(guide).flatMap(block => (
    (block.results || []).flatMap(result => [
      ...(result.proposals || []),
      ...(result.proposal ? [result.proposal] : []),
    ])
  ));

  assert.ok(proposals.length >= 4, 'expected revised, partial, and finalized proposal examples');
  for (const proposal of proposals) {
    assert.equal(proposal.terms_digest, termsDigest(proposal.commercial_terms));
  }
});

test('guide stays aligned with the shared scenario and conformance surface', () => {
  for (const term of [
    'Sam',
    'Pinnacle Agency',
    'StreamHaus',
    'media_buy_seller/typed_proposal_negotiation',
    'constraint_unsatisfiable',
    'hold_unavailable',
    'batch_aborted',
    'change_kind: "amendment"',
    'change_kind: "cancellation"',
  ]) {
    assert.match(guide, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('budget compatibility fails closed when proposal constraints cannot be preserved', () => {
  assert.match(
    guide,
    /request_proposals\.criteria\.offer_filters\.budget_range[\s\S]*?MAY project[\s\S]*?get_products\.filters\.budget_range[\s\S]*?inclusive[\s\S]*?MUST NOT perform currency conversion/
  );
  assert.match(
    guide,
    /MUST NOT project `refine_proposals\.refinements\[\]\.constraints\.total_budget` to `get_products\.filters\.budget_range`/
  );
  assert.match(
    guide,
    /present `criteria\.offer_filters` replaces that entire criterion[\s\S]*?MUST project the complete replacement object[\s\S]*?reject before dispatch[\s\S]*?omitted[\s\S]*?MUST also omit legacy `filters`[\s\S]*?bound discovery constraints/
  );
  assert.match(
    guide,
    /Legacy `finalize` asks for firm pricing[\s\S]*?MAY project finalize only when[\s\S]*?preserves the complete commercial terms[\s\S]*?MUST reject before dispatch/
  );
  for (const field of [
    "code: 'PRE_MUTATION_UNSUPPORTED'",
    "reason: 'NO_LOSSLESS_LEGACY_MAPPING'",
    "'exact_discovery_offer_filter_state'",
    "'proposal_total_budget_constraint'",
    "'immutable_finalize_terms'",
    "recovery: 'USE_COMPACT_LIFECYCLE' | 'REFORMULATE_REQUEST'",
    'dispatched: false',
    '/refinements/0/constraints/total_budget',
    '/refinements/0/action',
  ]) {
    assert.ok(guide.includes(field), `missing typed rejection field: ${field}`);
  }

  assert.match(refineProposalsReference, /PRE_MUTATION_UNSUPPORTED[\s\S]*?RFC 6901/);
  assert.match(refineProposalsReference, /whole-field replacement[\s\S]*?Legacy finalize/);
  assert.doesNotMatch(guide, /legacy `budget_range` is a soft discovery/);
  assert.doesNotMatch(refineProposalsReference, /legacy `budget_range` is a soft discovery/);
});

test('S1 links the guide and uses its shared scenario terminology', () => {
  assert.match(
    specialistModule,
    /\/docs\/media-buy\/product-discovery\/proposal-negotiation/
  );
  for (const term of ['Sam', 'Pinnacle Agency', 'StreamHaus']) {
    assert.match(specialistModule, new RegExp(term));
  }
});
