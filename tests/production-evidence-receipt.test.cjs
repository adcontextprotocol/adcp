const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, describe, it } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.resolve(__dirname, '../static/schemas/source');
const RECEIPT_URI = '/schemas/core/production-evidence-receipt.json';

function readSchema(uri) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

let schema;
let validate;
let examples;

function check(receipt) {
  return { ok: validate(receipt), errors: validate.errors };
}

// Assert the receipt is rejected AND that some error matches the intended rule,
// so an unrelated rule rejecting it cannot make a test pass.
function rejects(receipt, expected) {
  const result = check(receipt);
  assert.equal(result.ok, false, 'receipt should be rejected');
  const hit = result.errors.some(e => Object.entries(expected).every(([key, value]) => {
    if (key === 'missing') return e.keyword === 'required' && e.params.missingProperty === value;
    return e[key] === value;
  }));
  assert.ok(hit, `no error matched ${JSON.stringify(expected)}; got ${JSON.stringify(result.errors.map(e => [e.keyword, e.instancePath]))}`);
}

function mutate(base, fn) {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
}

describe('production evidence receipt', () => {
  let production;
  let sandbox;

  before(async () => {
    schema = readSchema(RECEIPT_URI);
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async ref => readSchema(ref) });
    addFormats(ajv);
    validate = await ajv.compileAsync(schema);
    examples = schema.examples;
    [production, sandbox] = examples;
  });

  it('is experimental and registered in the schema index', () => {
    assert.equal(schema['x-status'], 'experimental');
    const index = JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'index.json'), 'utf8'));
    assert.ok(JSON.stringify(index).includes(RECEIPT_URI));
  });

  it('accepts every published example', () => {
    assert.ok(examples.length >= 2);
    for (const example of examples) {
      const result = check(example);
      assert.ok(result.ok, JSON.stringify(result.errors));
    }
  });

  describe('independence', () => {
    const interop = r => {
      r.evidence_tier = 'independently_interoperable';
      r.environment = 'controlled_pilot';
      r.counterparty_relation = 'independent';
      r.lifecycle_stages_reached = ['capabilities_read', 'products_discovered'];
    };

    it('requires issuer_counterparty_roles on every receipt', () => {
      rejects(mutate(sandbox, r => delete r.issuer_counterparty_roles), { missing: 'issuer_counterparty_roles' });
    });

    it('lets an intermediary issue tiers below independently_interoperable alone', () => {
      const receipt = mutate(sandbox, r => {
        r.evidence_tier = 'sandbox_interoperable';
        r.issuer_counterparty_roles = ['network_intermediary'];
      });
      assert.ok(check(receipt).ok);
    });

    for (const [label, shape] of [['independently_interoperable', interop], ['production_transacted', () => {}]]) {
      it(`requires a co-signer at ${label} when the issuer declares any role`, () => {
        const receipt = mutate(production, r => { shape(r); delete r.co_signers; });
        rejects(receipt, { missing: 'co_signers' });
      });
    }

    it('accepts the independently_interoperable shape with an independent co-signer', () => {
      assert.ok(check(mutate(production, interop)).ok);
    });

    it('rejects a co-signer that itself declares a role', () => {
      const receipt = mutate(production, r => { r.co_signers[0].counterparty_roles = ['network_intermediary']; });
      rejects(receipt, { keyword: 'contains', instancePath: '/co_signers' });
    });

    it('rejects a co-signer tied to the issuer or compensated by a party to the claim', () => {
      for (const role of ['issuer_affiliate', 'compensated_by_issuer_or_subject']) {
        const receipt = mutate(production, r => { r.co_signers[0].counterparty_roles = [role]; });
        rejects(receipt, { keyword: 'contains', instancePath: '/co_signers' });
      }
    });

    it('accepts one independent co-signer alongside a conflicted one', () => {
      const receipt = mutate(production, r => {
        const conflicted = structuredClone(r.co_signers[0]);
        conflicted.counterparty_roles = ['transaction_counterparty'];
        conflicted.attestation.issuer = { type: 'origin', origin: 'https://other-network.example' };
        r.co_signers.unshift(conflicted);
      });
      assert.ok(check(receipt).ok);
    });

    it('binds the co-signer to a distinct endorsement claim over a digest-pinned resource subject', () => {
      rejects(mutate(production, r => { r.co_signers[0].attestation.claim_type = 'https://adcontextprotocol.org/claims/production-evidence'; }),
        { instancePath: '/co_signers/0/attestation/claim_type' });
      rejects(mutate(production, r => { delete r.co_signers[0].attestation.subject.content_digest; }),
        { missing: 'content_digest' });
      rejects(mutate(production, r => {
        r.co_signers[0].attestation.subject = { type: 'agent', agent_url: 'https://sales.pinnacle-media.example/adcp' };
      }), { keyword: 'const', instancePath: '/co_signers/0/attestation/subject/type' });
    });

    it('bounds the co-signer list', () => {
      const dup = mutate(production, r => { r.co_signers.push(structuredClone(r.co_signers[0])); });
      rejects(dup, { keyword: 'uniqueItems' });
      const many = mutate(production, r => {
        r.co_signers = Array.from({ length: 9 }, (_, i) => {
          const c = structuredClone(r.co_signers[0]);
          c.attestation.issuer = { type: 'origin', origin: `https://auditor-${i}.example` };
          return c;
        });
      });
      rejects(many, { keyword: 'maxItems' });
    });

    // Documents a known limit rather than endorsing it: an empty array is the issuer's own
    // claim. Evaluators must back it with their accepted-issuer policy (see the spec).
    it('accepts an empty role declaration at independently_interoperable and above without a co-signer, as a claim only', () => {
      const receipt = mutate(production, r => {
        r.issuer_counterparty_roles = [];
        delete r.co_signers;
      });
      assert.ok(check(receipt).ok);
    });

    it('forbids subject operators and affiliates from independently_interoperable and above', () => {
      for (const role of ['subject_operator', 'subject_affiliate', 'issuer_affiliate']) {
        const receipt = mutate(production, r => { r.issuer_counterparty_roles = [role]; });
        rejects(receipt, { keyword: 'enum', instancePath: '/issuer_counterparty_roles/0' });
      }
    });

    it('requires a published issuance policy and a counterparty_relation at independently_interoperable and above', () => {
      rejects(mutate(production, r => delete r.issuance_policy), { missing: 'issuance_policy' });
      rejects(mutate(production, r => delete r.counterparty_relation), { missing: 'counterparty_relation' });
    });

    it('requires an independent counterparty for independently_interoperable only', () => {
      for (const relation of ['affiliated', 'unknown']) {
        rejects(mutate(production, r => { interop(r); r.counterparty_relation = relation; }),
          { keyword: 'const', instancePath: '/counterparty_relation' });
        assert.ok(check(mutate(production, r => { r.counterparty_relation = relation; })).ok, `production tier carries ${relation}`);
      }
    });
  });

  describe('tier and scope consistency', () => {
    it('requires production environment for production tiers', () => {
      rejects(mutate(production, r => { r.environment = 'sandbox'; }), { keyword: 'const', instancePath: '/environment' });
    });

    it('keeps conformance_passed in sandbox and independently_interoperable out of production', () => {
      rejects(mutate(sandbox, r => { r.environment = 'production'; }), { keyword: 'const', instancePath: '/environment' });
      rejects(mutate(production, r => {
        r.evidence_tier = 'independently_interoperable';
        r.counterparty_relation = 'independent';
      }), { keyword: 'enum', instancePath: '/environment' });
    });

    it('requires an accepted MediaBuy for production_transacted', () => {
      rejects(mutate(production, r => { r.lifecycle_stages_reached = ['capabilities_read']; }),
        { keyword: 'contains', instancePath: '/lifecycle_stages_reached' });
    });

    it('requires delivery, reporting, and reconciliation for production_delivered_reconciled', () => {
      const partial = mutate(production, r => { r.evidence_tier = 'production_delivered_reconciled'; });
      rejects(partial, { keyword: 'contains', instancePath: '/lifecycle_stages_reached' });
      const full = mutate(production, r => {
        r.evidence_tier = 'production_delivered_reconciled';
        r.lifecycle_stages_reached.push('delivery_non_zero', 'reporting_read_back', 'reconciliation_completed');
        r.tasks_exercised.push('get_media_buy_delivery');
      });
      assert.ok(check(full).ok);
    });

    it('requires the task that produces a lifecycle stage', () => {
      rejects(mutate(production, r => { r.tasks_exercised = ['get_products']; }),
        { keyword: 'contains', instancePath: '/tasks_exercised' });
      rejects(mutate(production, r => {
        r.lifecycle_stages_reached.push('delivery_non_zero');
      }), { keyword: 'contains', instancePath: '/tasks_exercised' });
    });
  });

  describe('privacy defaults', () => {
    it('has no representation for spend, price, client, or counterparty identity', () => {
      for (const field of ['spend', 'price', 'campaign', 'client', 'counterparties']) {
        rejects(mutate(production, r => { r[field] = 'x'; }), { keyword: 'additionalProperties' });
      }
    });

    it('records observations at day granularity', () => {
      rejects(mutate(production, r => { r.observation.first_observed_date = '2026-09-02T14:00:00Z'; }),
        { keyword: 'format', instancePath: '/observation/first_observed_date' });
    });

    it('requires subject consent for a public projection', () => {
      rejects(mutate(production, r => { delete r.publication.subject_consent; }), { missing: 'subject_consent' });
    });

    it('requires consent for any named party', () => {
      const party = { type: 'origin', origin: 'https://other-network.example' };
      rejects(mutate(production, r => { r.named_parties = [{ party }]; }), { missing: 'consent' });
      const withConsent = mutate(production, r => {
        r.named_parties = [{
          party,
          consent: { consented_at: '2026-10-01T00:00:00Z', consent_digest: `sha256:${'3'.repeat(64)}` },
        }];
      });
      assert.ok(check(withConsent).ok);
    });
  });
});
