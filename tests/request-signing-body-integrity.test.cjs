const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const {
  evaluateBodyIntegrity,
  usesUniversalBodyIntegrity,
} = require('./helpers/reference-request-signing-body-integrity.cjs');

const fixturePath = path.join(
  __dirname,
  '../static/compliance/source/test-vectors/request-signing/body-integrity-policy.json'
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const protocolMethodFixturePath = path.join(
  path.dirname(fixturePath),
  'protocol-method-names.json'
);
const protocolMethodFixture = JSON.parse(fs.readFileSync(protocolMethodFixturePath, 'utf8'));
const capabilitiesSchemaPath = path.join(
  __dirname,
  '../static/schemas/source/protocol/get-adcp-capabilities-response.json'
);
const capabilitiesSchema = JSON.parse(fs.readFileSync(capabilitiesSchemaPath, 'utf8'));
const schemaRoot = path.join(__dirname, '../static/schemas/source');
const legacySchemaRoot = path.join(__dirname, '../dist/schemas/3.1.1');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  const [schemaUri] = uri.split('#');
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, schemaUri.slice('/schemas/'.length)), 'utf8'));
}

async function compileRequestSchema(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function readLegacySchema(uri) {
  assert.match(uri, /^\/schemas\/3\.1\.1\//);
  const [schemaUri] = uri.split('#');
  return JSON.parse(fs.readFileSync(path.join(legacySchemaRoot, schemaUri.slice('/schemas/3.1.1/'.length)), 'utf8'));
}

async function compileLegacyRequestSchema(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readLegacySchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readLegacySchema(uri));
}

describe('AdCP 3.2 request-signing body-integrity policy', () => {
  it('pins the fixture to the 3.2 signing profile', () => {
    assert.equal(fixture.profile_version, '3.2');
  });

  for (const testCase of fixture.cases) {
    it(testCase.id, () => {
      assert.deepEqual(evaluateBodyIntegrity(testCase), testCase.expected);
    });
  }

  it('covers all six operation and protocol-method list modes', () => {
    const modes = new Set(fixture.cases.map(testCase => testCase.mode));
    assert.deepEqual(
      [...modes].sort(),
      [
        'protocol_methods_required_for',
        'protocol_methods_supported_for',
        'protocol_methods_warn_for',
        'required_for',
        'supported_for',
        'warn_for',
      ]
    );
  });

  it('applies the body-integrity profile to 3.2 prereleases and later releases', () => {
    for (const version of ['3.2-beta.1', '3.2', '3.3', '4.0', '10.0']) {
      assert.equal(usesUniversalBodyIntegrity(version), true, version);
    }
    for (const version of ['3.0', '3.1-rc.1', '3.1']) {
      assert.equal(usesUniversalBodyIntegrity(version), false, version);
    }
  });

  it('pins the root positive wire suite to the 3.1 encoding profile', () => {
    const positiveDir = path.join(path.dirname(fixturePath), 'positive');
    for (const file of fs.readdirSync(positiveDir).filter(name => name.endsWith('.json'))) {
      const vector = JSON.parse(fs.readFileSync(path.join(positiveDir, file), 'utf8'));
      assert.equal(vector.signing_profile_version, '3.1', file);
    }
  });

  it('cryptographically verifies the legacy 3.1 body-bound positive', () => {
    const baseDir = path.dirname(fixturePath);
    const vector = JSON.parse(fs.readFileSync(path.join(baseDir, 'positive/002-post-with-content-digest.json'), 'utf8'));
    const keys = JSON.parse(fs.readFileSync(path.join(baseDir, 'keys.json'), 'utf8'));
    const jwk = keys.keys.find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signature = vector.request.headers.Signature.match(/^sig1=:([^:]+):$/)?.[1];
    const digest = vector.request.headers['Content-Digest'].match(/^sha-256=:([^:]+):$/)?.[1];

    assert.equal(vector.signing_profile_version, '3.1');
    assert.match(signature, /[-_]/, 'legacy signature must use Base64URL');
    assert.doesNotMatch(digest, /[+/=]/, 'legacy digest must use unpadded Base64URL');
    assert.equal(crypto.createHash('sha256').update(vector.request.body).digest('base64url'), digest);
    assert.equal(
      crypto.verify(null, Buffer.from(vector.expected_signature_base), publicKey, Buffer.from(signature, 'base64url')),
      true
    );
  });

  it('pins the legacy negative wire suite to the 3.1 encoding profile', () => {
    const negativeDir = path.join(path.dirname(fixturePath), 'negative');
    for (const file of fs.readdirSync(negativeDir).filter(name => name.endsWith('.json'))) {
      const vector = JSON.parse(fs.readFileSync(path.join(negativeDir, file), 'utf8'));
      assert.equal(vector.signing_profile_version, '3.1', file);
    }
  });

  // Restored from #7580, which #7581 removed, and extended to profile-3.2/: the three
  // vectors hand-authored there predate the generator and never received a schema-valid
  // body. A body that is not a valid request makes grading depend on whether a verifier
  // validates the request before or after the signature (adcp#7567).
  it('uses operation-valid bodies in every routed signing vector', async () => {
    const baseDir = path.dirname(fixturePath);
    const schemas = {
      create_media_buy: {
        current: await compileRequestSchema('/schemas/media-buy/create-media-buy-request.json'),
        legacy: await compileLegacyRequestSchema('/schemas/3.1.1/media-buy/create-media-buy-request.json'),
      },
      sync_creatives: {
        current: await compileRequestSchema('/schemas/creative/sync-creatives-request.json'),
        legacy: await compileLegacyRequestSchema('/schemas/3.1.1/creative/sync-creatives-request.json'),
      },
      update_media_buy: {
        current: await compileRequestSchema('/schemas/media-buy/update-media-buy-request.json'),
        legacy: await compileLegacyRequestSchema('/schemas/3.1.1/media-buy/update-media-buy-request.json'),
      },
    };
    // 028 addresses the MCP endpoint with a JSON-RPC envelope; positive/007 and 008 address
    // paths that are not AdCP operations. None of them carries an operation body.
    const unrouted = name => name.startsWith('028-');
    const unroutedPositive = name => name.startsWith('007-') || name.startsWith('008-');
    const suites = [
      { dir: 'negative', skip: unrouted, profiles: ['current', 'legacy'] },
      { dir: 'positive', skip: unroutedPositive, profiles: ['current', 'legacy'] },
      { dir: 'profile-3.2/negative', skip: unrouted, profiles: ['current'] },
      { dir: 'profile-3.2/positive', skip: unroutedPositive, profiles: ['current'] },
    ];

    for (const { dir, skip, profiles } of suites) {
      const files = fs.readdirSync(path.join(baseDir, dir)).filter(name => name.endsWith('.json') && !skip(name));
      assert.ok(files.length > 0, `${dir} has no routed vectors`);
      for (const file of files) {
        const vector = JSON.parse(fs.readFileSync(path.join(baseDir, dir, file), 'utf8'));
        const operation = Object.keys(schemas).find(name => new URL(vector.request.url).pathname.endsWith(`/${name}`));
        assert.ok(operation, `no request schema selected for ${dir}/${file}`);
        const body = JSON.parse(vector.request.body);
        for (const profile of profiles) {
          const validate = schemas[operation][profile];
          assert.equal(
            validate(body),
            true,
            `${dir}/${file} has a schema-invalid ${operation} body for ${profile}: ${JSON.stringify(validate.errors)}`,
          );
        }
      }
    }
  });

  it('cryptographically verifies the 3.2 body-bearing positive vector', () => {
    const baseDir = path.dirname(fixturePath);
    const vector = JSON.parse(fs.readFileSync(
      path.join(baseDir, 'profile-3.2/positive/001-post-with-content-digest.json'),
      'utf8'
    ));
    const keys = JSON.parse(fs.readFileSync(path.join(baseDir, 'keys.json'), 'utf8'));
    const jwk = keys.keys.find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      format: 'jwk',
    });
    const signature = vector.request.headers.Signature.match(/^sig1=:([^:]+):$/)?.[1];
    assert.ok(signature, 'vector signature must use the sig1 structured-field label');
    assert.equal(vector.signing_profile_version, '3.2');
    assert.match(vector.request.headers['Signature-Input'], /"content-digest"/);
    const digest = vector.request.headers['Content-Digest'].match(/^sha-256=:([^:]+):$/)?.[1];
    assert.ok(digest, 'vector must carry a sha-256 Content-Digest');
    assert.doesNotMatch(digest, /[-_]/, 'sf-binary must use the standard Base64 alphabet');
    assert.equal(crypto.createHash('sha256').update(vector.request.body).digest('base64'), digest);
    assert.equal(
      crypto.verify(null, Buffer.from(vector.expected_signature_base), publicKey, Buffer.from(signature, 'base64')),
      true
    );
  });

  it('rejects a cryptographically valid legacy Base64URL Signature token in 3.2', () => {
    const baseDir = path.dirname(fixturePath);
    const vector = JSON.parse(fs.readFileSync(
      path.join(baseDir, 'profile-3.2/negative/001-base64url-sf-binary.json'),
      'utf8'
    ));
    const keys = JSON.parse(fs.readFileSync(path.join(baseDir, 'keys.json'), 'utf8'));
    const jwk = keys.keys.find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signature = vector.request.headers.Signature.match(/^sig1=:([^:]+):$/)?.[1];

    assert.equal(vector.signing_profile_version, '3.2');
    assert.match(signature, /[-_]/, 'negative must exercise the legacy Base64URL alphabet');
    assert.equal(vector.expected_outcome.error_code, 'request_signature_header_malformed');
    assert.equal(
      crypto.verify(null, Buffer.from(vector.expected_signature_base), publicKey, Buffer.from(signature, 'base64url')),
      true,
      'the raw signature must be valid so only sf-binary parsing causes rejection'
    );
  });
});

describe('AdCP 3.2 request-signing protocol-method names', () => {
  const requestSigningProperties = capabilitiesSchema.properties.request_signing.properties;
  const protocolMethodFields = [
    'protocol_methods_supported_for',
    'protocol_methods_warn_for',
    'protocol_methods_required_for',
  ];
  const acceptsDeclaration = (field, method) => {
    const itemSchema = requestSigningProperties[field].items;
    return method.length <= itemSchema.maxLength
      && new RegExp(itemSchema.pattern).test(method)
      && itemSchema.not?.const !== method;
  };

  it('pins the fixture to the 3.2 signing profile', () => {
    assert.equal(protocolMethodFixture.profile_version, '3.2');
  });

  it('uses one declaration schema for all three protocol-method buckets', () => {
    const itemSchemas = protocolMethodFields.map(
      field => JSON.stringify(requestSigningProperties[field].items)
    );
    assert.equal(new Set(itemSchemas).size, 1);
  });

  for (const declaration of protocolMethodFixture.valid_declarations) {
    it(`accepts ${declaration.family} wire method names`, () => {
      for (const field of protocolMethodFields) {
        for (const method of declaration.methods) {
          assert.equal(acceptsDeclaration(field, method), true, `${field} must accept ${method}`);
        }
      }
    });
  }

  it('keeps lower_snake_case AdCP operations and malformed paths out of the protocol namespace', () => {
    for (const method of protocolMethodFixture.invalid_declarations) {
      for (const field of protocolMethodFields) {
        assert.equal(acceptsDeclaration(field, method), false, `${field} must reject ${method}`);
      }
    }
  });

  it('bounds protocol method declarations', () => {
    for (const field of protocolMethodFields) {
      assert.equal(acceptsDeclaration(field, 'A'.repeat(256)), true);
      assert.equal(acceptsDeclaration(field, 'A'.repeat(257)), false);
    }
  });

  for (const testCase of protocolMethodFixture.exact_match_cases) {
    it(testCase.id, () => {
      assert.equal(new Set(testCase.declared_methods).has(testCase.wire_method), testCase.matches);
    });
  }
});
