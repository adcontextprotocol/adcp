const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const read = (name) => readBuiltSchema(`/schemas/${name}`);
const ajv = new Ajv({
  allErrors: true, strict: false,
  loadSchema: async (uri) => {
    assert.ok(uri.startsWith('/schemas/'), `unexpected schema reference: ${uri}`);
    return read(uri.slice('/schemas/'.length));
  },
});
addFormats(ajv);

const compiled = new Map();
const roots = new Map();
// A document, or a sub-schema of one (`ref` is `<file>#/oneOf/1` and the like).
function compile(ref) {
  const [file, pointer] = ref.split('#');
  if (!roots.has(file)) roots.set(file, ajv.compileAsync(read(file)));
  if (!pointer) return roots.get(file);
  if (!compiled.has(ref)) {
    compiled.set(ref, roots.get(file).then(() => ajv.compileAsync({ $ref: `/schemas/${file}#${pointer}` })));
  }
  return compiled.get(ref);
}
async function check(ref, payload) {
  const validate = await compile(ref);
  return { valid: validate(payload), errors: JSON.stringify(validate.errors, null, 2) };
}
async function assertValid(ref, payload) {
  const { valid, errors } = await check(ref, payload);
  assert.equal(valid, true, errors);
}
async function assertInvalid(ref, payload) {
  const { valid } = await check(ref, payload);
  assert.equal(valid, false);
}

const envelope = { status: 'completed' };
const errors = [{ code: 'INVALID_REQUEST', message: 'The request was rejected' }];
const artifact = { property_rid: 'rid_1', artifact_id: 'article_1', assets: [] };

// Each union: document, the success and error shapes, and the key the success branch is told by.
const RESPONSES = [
  {
    name: 'calibrate_content',
    file: 'content-standards/calibrate-content-response.json',
    success: { verdict: 'passed' },
    badKey: { verdict: 'not-a-verdict' },
  },
  {
    name: 'create_content_standards',
    file: 'content-standards/create-content-standards-response.json',
    success: { standards_id: 'std_1' },
  },
  {
    name: 'get_content_standards',
    file: 'content-standards/get-content-standards-response.json',
    success: { standards_id: 'std_1' },
  },
  {
    name: 'get_media_buy_artifacts',
    file: 'content-standards/get-media-buy-artifacts-response.json',
    success: { media_buy_id: 'mb_1', artifacts: [{ record_id: 'r1', artifact }] },
    // Echoing the media buy ID on an error must not read as a success.
    badKey: { media_buy_id: 'mb_1' },
  },
  {
    name: 'list_content_standards',
    file: 'content-standards/list-content-standards-response.json',
    success: { standards: [{ standards_id: 'std_1' }] },
  },
  {
    name: 'validate_content_delivery',
    file: 'content-standards/validate-content-delivery-response.json',
    success: {
      summary: { total_records: 1, passed_records: 1, failed_records: 0 },
      results: [{ record_id: 'r1', verdict: 'passed' }],
    },
  },
];

for (const { name, file, success, badKey } of RESPONSES) {
  const root = `${file}`;
  const loser = `${file}#/oneOf/1`;
  const winner = `${file}#/oneOf/0`;

  test(`${name} response that is both a success and an error is accepted as the success shape`, async () => {
    const body = { ...envelope, ...success, errors };
    await assertValid(root, body);
    await assertValid(winner, body);
    await assertInvalid(loser, body);
  });

  test(`${name} success-only response is still accepted`, async () => {
    await assertValid(root, { ...envelope, ...success });
  });

  test(`${name} error-only response is still accepted`, async () => {
    await assertValid(root, { ...envelope, errors });
  });

  if (badKey) {
    test(`${name} error response carrying a malformed success key is still accepted as the error shape`, async () => {
      const body = { ...envelope, errors, ...badKey };
      await assertValid(root, body);
      await assertInvalid(winner, body);
    });
  }
}

const PROPERTY_FILE = 'property/property-feature-result.json';
const PROPERTY = `${PROPERTY_FILE}#/properties/property`;
const PROPERTY_BRANCHES = `${PROPERTY}/oneOf`;

test('a property ID is accepted as the property ID branch', async () => {
  for (const id of ['homepage', 'cnn_ctv_app']) {
    await assertValid(PROPERTY, id);
    await assertValid(`${PROPERTY_BRANCHES}/1`, id);
    await assertInvalid(`${PROPERTY_BRANCHES}/0`, id);
  }
});

test('a domain string is still accepted as the domain branch', async () => {
  await assertValid(PROPERTY, 'example.com');
  await assertValid(`${PROPERTY_BRANCHES}/0`, 'example.com');
  await assertInvalid(`${PROPERTY_BRANCHES}/1`, 'example.com');
});

const ADAGENTS = 'adagents.json';
const reference = { authoritative_location: 'https://cdn.example.com/adagents.json' };
const inline = {
  authorized_agents: [{
    url: 'https://agent.example.com',
    authorized_for: 'Official sales agent',
    authorization_type: 'property_tags',
    property_tags: ['all'],
  }],
};

test('adagents file with both an authoritative location and inline agents is accepted as the URL reference variant', async () => {
  const body = { ...reference, ...inline };
  await assertValid(ADAGENTS, body);
  await assertValid(`${ADAGENTS}#/oneOf/0`, body);
  await assertInvalid(`${ADAGENTS}#/oneOf/1`, body);
});

test('adagents reference-only file is still accepted', async () => {
  await assertValid(ADAGENTS, reference);
});

test('adagents inline-only file is still accepted', async () => {
  await assertValid(ADAGENTS, inline);
});

test('adagents inline file carrying a non-HTTPS authoritative location is still accepted as the inline variant', async () => {
  const body = { ...inline, authoritative_location: 'http://cdn.example.com/adagents.json' };
  await assertValid(ADAGENTS, body);
  await assertInvalid(`${ADAGENTS}#/oneOf/0`, body);
});

const URL_REFERENCE = { type: 'url', value: 'https://example.com/article' };
const EXEMPLAR_SITES = [
  ['create', 'content-standards/create-content-standards-request.json'],
  ['update', 'content-standards/update-content-standards-request.json'],
].flatMap(([verb, file]) => ['pass', 'fail'].map((side) => ({
  label: `${verb} request ${side} exemplar`,
  branches: `${file}#/properties/calibration_exemplars/properties/${side}/items/oneOf`,
})));

for (const { label, branches } of EXEMPLAR_SITES) {
  test(`${label} that is both a URL reference and an artifact is accepted as the artifact`, async () => {
    const both = { ...artifact, ...URL_REFERENCE };
    await assertValid(branches.replace(/\/oneOf$/, ''), both);
    await assertValid(`${branches}/1`, both);
    await assertInvalid(`${branches}/0`, both);
  });

  test(`${label} that is only a URL reference is still accepted`, async () => {
    await assertValid(branches.replace(/\/oneOf$/, ''), URL_REFERENCE);
  });

  test(`${label} that is only an artifact is still accepted`, async () => {
    await assertValid(branches.replace(/\/oneOf$/, ''), artifact);
  });
}
