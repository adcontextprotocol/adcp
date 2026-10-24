/**
 * #8198: a creative agent's `creative.supported_formats` catalog must not make
 * its own signing keys unresolvable. The signing-key discovery fetch reads only
 * `identity`, `request_signing`, and `webhook_signing`, so the verifier asks for
 * exactly those with `scope: "signing_discovery"` and the 64 KiB budget binds
 * the scoped document instead of the full one.
 *
 * Pins the request schema, the verifier and responder obligations in
 * `security.mdx`, and the invariant that the budget itself did not move.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const request = JSON.parse(read('static/schemas/source/protocol/get-adcp-capabilities-request.json'));
const security = read('docs/building/by-layer/L1/security.mdx');
const reference = read('docs/protocol/get_adcp_capabilities.mdx');
const responseSize = read('docs/building/concepts/managing-response-size.mdx');
const migration = read('docs/reference/migration/3-2-to-3-3.mdx');

describe('get_adcp_capabilities scope (#8198)', () => {
  it('adds an optional scope that defaults to the whole document', () => {
    const scope = request.properties.scope;
    assert.deepEqual(scope.enum, ['full', 'signing_discovery']);
    assert.equal(scope.default, 'full');
    assert.equal(scope['x-added-in'], '3.3.0');
    assert.ok(!(request.required || []).includes('scope'), 'scope must stay optional');
    assert.notEqual(request.additionalProperties, false, 'older agents must keep tolerating unknown fields');
  });

  it('names the blocks a scoped response carries and the pre-3.3 behavior', () => {
    const d = request.properties.scope.description;
    for (const block of ['adcp', 'supported_protocols', 'identity', 'request_signing', 'webhook_signing']) {
      assert.ok(d.includes('`' + block + '`') || d.includes('`' + block + '` '), `description must name ${block}`);
    }
    assert.match(d, /predates 3\.3 ignores the field/);
    assert.match(d, /MUST NOT cache it as one/);
  });
});

describe('security.mdx key-discovery chain', () => {
  const section = security.slice(security.indexOf('##### Scoped capabilities for key discovery'));
  const scoped = section.slice(0, section.indexOf('**Trust roots.**'));

  it('has the scoped-capabilities subsection', () => {
    assert.ok(scoped.length > 200, 'subsection missing');
  });

  it('makes step 1 and the quickstart request the scope', () => {
    const step1 = security.match(/^1\. Fetch `A`'s `get_adcp_capabilities`[^\n]*/m)[0];
    assert.match(step1, /scope: "signing_discovery"/);
    assert.match(security, /invoke `get_adcp_capabilities` with `scope: "signing_discovery"`/);
    assert.match(security, /scope: 'signing_discovery',/);
  });

  it('binds verifiers and responders', () => {
    assert.match(scoped, /verifier therefore MUST send `scope: "signing_discovery"`/);
    assert.match(scoped, /declares any signing posture[^]*MUST honor `scope: "signing_discovery"`/);
    assert.match(scoped, /MUST NOT retry unscoped/);
    assert.match(scoped, /MUST NOT cache it as one/);
  });

  it('does not raise the budget, and keeps the unscoped fallback honest', () => {
    assert.match(scoped, /`MAX_CAPABILITIES_BYTES` \(64 KiB\) applies to whatever body arrives/);
    assert.match(security, /const MAX_CAPABILITIES_BYTES = 65_536;/);
    assert.match(scoped, /predates 3\.3 ignores the field/);
    assert.match(scoped, /Web Bot Auth profile/);
  });
});

describe('adopter-facing docs', () => {
  it('documents the request parameter on the reference page', () => {
    assert.match(reference, /\| `scope` \| string \| Optional, since 3\.3\./);
  });

  it('no longer says the signing-key path cannot narrow', () => {
    assert.doesNotMatch(responseSize, /the signing-key path cannot\./);
    assert.match(responseSize, /scope: "signing_discovery"/);
    assert.match(responseSize, /Web Bot Auth profile/);
  });

  it('has a migration entry that says the decoupling needs two 3.3 peers', () => {
    assert.match(migration, /### Signing-key discovery fetches a scoped capabilities document/);
    assert.match(migration, /only between two 3\.3 peers/);
  });
});
