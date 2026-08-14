#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractDocCodeClaims,
  lint,
} = require('../scripts/lint-doc-compliance-drift.cjs');

const VERIFY_VECTOR_BLOCK = `
\`\`\`bash
npx @adcp/sdk@latest signing verify-vector --vector /tmp/vector.json --keys /tmp/keys.json
\`\`\`
`;

function withVerifyVector(markdown) {
  return `${markdown}${VERIFY_VECTOR_BLOCK}`;
}

function isCatalogQualifiedRequirement(clause) {
  return /\bcatalog[- ]bearing\b/i.test(clause) ||
    /\b(?:when|if|unless)\b[^.\n;]*\bcatalog\b/i.test(clause) ||
    /\bcatalog\b[^.\n;]*\b(?:when|if|unless)\b/i.test(clause) ||
    /\b(?:get_products|product discovery)\b[^.\n;]*\b(?:with|including|that includes?|containing)\b[^.\n;]*\bcatalog\b/i.test(clause) ||
    /\bcatalog\b[^.\n;]*\b(?:get_products|product discovery)\b/i.test(clause);
}

function findUnqualifiedBrandRequirement(markdown) {
  return markdown
    .replaceAll('`', '')
    .split(/[.\n;]|,\s+(?:and|but)\s+/i)
    .map(clause => clause.trim())
    .find(clause =>
      /\b(?:get_products|product discovery)\b/i.test(clause) &&
      /\bbrand\b/i.test(clause) &&
      /\b(?:must|shall|mandatory|require(?:d|s)?|needs?)\b/i.test(clause) &&
      !isCatalogQualifiedRequirement(clause));
}

function makeFixture({ code = 'request_signature_required' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-doc-compliance-drift-'));
  const contractRoot = path.join(
    root,
    'static',
    'compliance',
    'source',
    'test-vectors',
    'request-signing',
  );
  const negativeDir = path.join(contractRoot, 'negative');
  const docPath = path.join(root, 'docs', 'building', 'by-layer', 'L1', 'request-signing.mdx');
  const gradingDocPath = path.join(root, 'docs', 'building', 'verification', 'grading.mdx');
  fs.mkdirSync(negativeDir, { recursive: true });
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.mkdirSync(path.dirname(gradingDocPath), { recursive: true });
  fs.writeFileSync(
    path.join(negativeDir, '001-required.json'),
    JSON.stringify({ expected_outcome: { success: false, error_code: code } }),
  );
  fs.writeFileSync(docPath, withVerifyVector('### Error codes\n'));
  fs.writeFileSync(gradingDocPath, withVerifyVector('# Grading\n'));
  return { root, contractRoot, docPath, gradingDocPath };
}

test('repository request-signing guide matches the current source vectors', () => {
  const result = lint();
  assert.deepEqual(result.errors, []);
  assert.ok(result.contractCodes.has('request_signature_required'));
});

test('the original seven-code phantom table fails completely', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.docPath, withVerifyVector(`# Guide

### Error codes

| Code | Meaning |
|---|---|
| \`missing_signature\` | missing |
| \`invalid_signature\` | invalid |
| \`expired_signature\` | expired |
| \`replayed_nonce\` | replayed |
| \`revoked_key\` | revoked |
| \`unknown_key\` | unknown |
| \`unsupported_algorithm\` | unsupported |

## Related
`));

  const result = lint(fixture);
  assert.equal(result.errors.length, 7);
  for (const code of [
    'missing_signature',
    'invalid_signature',
    'expired_signature',
    'replayed_nonce',
    'revoked_key',
    'unknown_key',
    'unsupported_algorithm',
  ]) {
    assert.ok(result.errors.some(error => error.includes(`\`${code}\``)), code);
  }
});

test('a table grounded in a vector code passes', () => {
  const fixture = makeFixture();
  fs.writeFileSync(
    fixture.docPath,
    withVerifyVector('### Error codes\n\n| Code | Meaning |\n|---|---|\n| `request_signature_required` | missing |\n'),
  );

  const result = lint(fixture);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.docCodes], ['request_signature_required']);
});

test('taxonomy prose and family references are outside the vector-code claim scope', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.docPath, withVerifyVector(`# Guide

The discovery path may return \`request_signature_brand_json_url_missing\`.

### Error codes

The \`brand_json_url\` field raises \`request_signature_brand_*\` and
\`request_signature_key_origin_*\` families documented elsewhere.

## Related
`));

  const result = lint(fixture);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.docCodes], []);
});

test('concrete request-signing literals in the section are checked outside tables too', () => {
  const claims = extractDocCodeClaims(`### Error codes

Return \`request_signature_required\`. The \`request_signature_brand_*\` family is separate.

## Related
`);
  assert.deepEqual([...claims], ['request_signature_required']);
});

test('headings inside fenced examples do not terminate the guarded section', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.docPath, withVerifyVector(`### Error codes

\`\`\`md
## Example response heading
\`\`\`

| Code | Meaning |
|---|---|
| \`missing_signature\` | invented |

## Related
`));
  const result = lint(fixture);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /missing_signature/);
});

test('media-buy brand guidance matches request schema requirements', () => {
  const getProducts = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../static/schemas/source/media-buy/get-products-request.json'),
    'utf8',
  ));
  const createMediaBuy = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../static/schemas/source/media-buy/create-media-buy-request.json'),
    'utf8',
  ));

  assert.ok(getProducts.required.includes('buying_mode'));
  assert.ok(!getProducts.required.includes('brand'));
  assert.deepEqual(getProducts.dependencies.catalog, ['brand']);
  assert.ok(createMediaBuy.required.includes('brand'));

  for (const relativePath of [
    '../docs/media-buy/product-discovery/brief-expectations.mdx',
    '../docs/media-buy/media-buys/policy-compliance.mdx',
  ]) {
    const doc = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    assert.match(doc, /`brand` (?:field )?is optional for `get_products` unless the request includes `catalog`/);
    assert.match(doc, /`create_media_buy` request (?:always )?(?:must include|requires) `brand`/);
    assert.match(doc, /general policy rules or limit (?:the products it returns|discovery)/);
    assert.equal(findUnqualifiedBrandRequirement(doc), undefined);
  }

  const briefGuide = fs.readFileSync(
    path.join(__dirname, '../docs/media-buy/product-discovery/brief-expectations.mdx'),
    'utf8',
  );
  assert.match(briefGuide, /For `buying_mode: "brief"`, `brief` is required/);
  assert.match(briefGuide, /For `buying_mode: "wholesale"`, omit `brief`/);
  assert.match(briefGuide, /For `buying_mode: "refine"`, omit `brief` and use the `refine` array instead/);

  const policyGuide = fs.readFileSync(
    path.join(__dirname, '../docs/media-buy/media-buys/policy-compliance.mdx'),
    'utf8',
  );
  assert.doesNotMatch(policyGuide, /policy_compliance/);
  assert.doesNotMatch(policyGuide, /three compliance statuses/i);
  assert.doesNotMatch(policyGuide, /"status": "(?:allowed|restricted|blocked)"/);
  assert.match(policyGuide, /"code": "POLICY_VIOLATION"/);
  assert.match(policyGuide, /"status": "input-required"[\s\S]{0,160}"task_id"[\s\S]{0,160}"context_id"/);
  assert.match(policyGuide, /Seller-internal review does not require buyer input/);
  assert.match(policyGuide, /return `submitted` with a `task_id`; use `working` for subsequent progress/);
});

test('brand guidance lint rejects unqualified requirements and allows catalog conditions', () => {
  for (const claim of [
    '`get_products` requires `brand`.',
    '`brand` must be provided to `get_products`.',
    '`brand` is required for product discovery.',
    'Every product discovery request needs a brand.',
  ]) {
    assert.equal(findUnqualifiedBrandRequirement(claim), claim.replaceAll('`', '').slice(0, -1));
  }

  for (const claim of [
    'Every catalog-bearing `get_products` request must include `brand`.',
    '`get_products` requires `brand` when `catalog` is present.',
    '`brand` is required for product discovery requests that include a catalog.',
  ]) {
    assert.equal(findUnqualifiedBrandRequirement(claim), undefined);
  }
});

test('removing the guarded section fails instead of silently disabling the lint', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.docPath, withVerifyVector('# Guide\n\nNo taxonomy here.\n'));
  const result = lint(fixture);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /missing expected "### Error codes" section/);
});

test('package-internal request-signing cache paths fail', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.docPath, `### Error codes

\`\`\`bash
adcp signing verify-vector \\
  --vector compliance/cache/3.0.0/test-vectors/request-signing/positive/001-basic-post.json \\
  --keys compliance/cache/3.0.0/test-vectors/request-signing/keys.json
\`\`\`
`);

  const result = lint(fixture);
  assert.ok(result.errors.some(error => error.includes('package-internal compliance/cache')));
});

test('the old stdin-only verify-vector guidance fails required input checks', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.gradingDocPath, `# Grading

\`\`\`bash
npx @adcp/sdk@latest signing verify-vector
\`\`\`

Reads a vector from stdin and reports whether it matches the expected output.
`);

  const result = lint(fixture);
  assert.ok(result.errors.some(error => error.includes('must pass --vector')));
  assert.ok(result.errors.some(error => error.includes('must pass --keys')));
  assert.ok(result.errors.some(error => error.includes('not stdin')));
});

test('removing verify-vector guidance from either guarded document fails', () => {
  for (const field of ['docPath', 'gradingDocPath']) {
    const fixture = makeFixture();
    fs.writeFileSync(
      fixture[field],
      field === 'docPath' ? '### Error codes\n' : '# Grading\n',
    );

    const result = lint(fixture);
    assert.ok(
      result.errors.some(error =>
        error.includes(path.relative(fixture.root, fixture[field])) &&
        error.includes('missing signing verify-vector invocation')),
      field,
    );
  }
});

test('verify-vector flags must belong to the verify command', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.gradingDocPath, `# Grading

\`\`\`bash
npx @adcp/sdk@latest signing verify-vector
printf '%s\\n' --vector /tmp/vector.json --keys /tmp/keys.json
\`\`\`
`);

  const result = lint(fixture);
  assert.ok(result.errors.some(error => error.includes('must pass --vector')));
  assert.ok(result.errors.some(error => error.includes('must pass --keys')));
});

test('verify-vector guidance requires explicit keys even with a local vector', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.docPath, `### Error codes

\`\`\`bash
npx @adcp/sdk@latest signing verify-vector --vector /tmp/vector.json
\`\`\`
`);

  const result = lint(fixture);
  assert.ok(result.errors.some(error => error.includes('must pass --keys')));
  assert.ok(!result.errors.some(error => error.includes('must pass --vector')));
});
