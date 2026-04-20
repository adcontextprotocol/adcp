/**
 * Unit tests for scripts/lint-storyboard-scoping.cjs.
 *
 * The lint enforces: every step that invokes a tenant-scoped task must carry
 * brand/account identity in sample_request, so consecutive steps land in the
 * same per-tenant session on sellers that scope state by brand.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const {
  TENANT_SCOPED_TASKS,
  EXEMPT_FROM_LINT,
  hasTenantIdentity,
  lintFile,
  lintScoping,
} = require('../scripts/lint-storyboard-scoping.cjs');

function writeYaml(dir, relPath, doc) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, yaml.dump(doc));
  return full;
}

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-scope-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('hasTenantIdentity', () => {
  it('accepts top-level brand.domain', () => {
    assert.equal(hasTenantIdentity({ brand: { domain: 'acme.example' } }), true);
  });
  it('accepts account.brand.domain', () => {
    assert.equal(hasTenantIdentity({ account: { brand: { domain: 'acme.example' }, operator: 'pinnacle.com' } }), true);
  });
  it('accepts account.account_id', () => {
    assert.equal(hasTenantIdentity({ account: { account_id: 'acct-123' } }), true);
  });
  it('accepts plans[*].brand.domain (sync_plans batch shape)', () => {
    assert.equal(hasTenantIdentity({ plans: [{ brand: { domain: 'acme.example' } }] }), true);
  });
  it('rejects empty request', () => {
    assert.equal(hasTenantIdentity({}), false);
  });
  it('rejects brand without domain', () => {
    assert.equal(hasTenantIdentity({ brand: { name: 'Acme' } }), false);
  });
  it('rejects null / non-object sample_request', () => {
    assert.equal(hasTenantIdentity(null), false);
    assert.equal(hasTenantIdentity('string'), false);
  });
});

describe('lintFile', () => {
  it('passes when every tenant-scoped step carries brand', () =>
    withTempRoot((root) => {
      const file = writeYaml(root, 'ok.yaml', {
        id: 'test',
        phases: [
          {
            steps: [
              {
                id: 'create',
                task: 'create_media_buy',
                stateful: true,
                sample_request: { brand: { domain: 'acme.example' } },
              },
              {
                id: 'read',
                task: 'get_media_buys',
                stateful: true,
                sample_request: { brand: { domain: 'acme.example' }, media_buy_ids: ['mb-1'] },
              },
            ],
          },
        ],
      });
      assert.deepEqual(lintFile(file, root), []);
    }));

  it('flags a tenant-scoped step missing brand', () =>
    withTempRoot((root) => {
      const file = writeYaml(root, 'bad.yaml', {
        id: 'test',
        phases: [
          {
            steps: [
              {
                id: 'read',
                task: 'get_media_buys',
                stateful: true,
                sample_request: { media_buy_ids: ['mb-1'] },
              },
            ],
          },
        ],
      });
      const hits = lintFile(file, root);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].step, 'read');
      assert.equal(hits[0].task, 'get_media_buys');
    }));

  it('respects scoping: global opt-out', () =>
    withTempRoot((root) => {
      const file = writeYaml(root, 'probe.yaml', {
        id: 'test',
        phases: [
          {
            steps: [
              {
                id: 'negative_budget',
                task: 'create_media_buy',
                scoping: 'global',
                sample_request: { start_time: '2026-01-01', budget: -1 },
              },
            ],
          },
        ],
      });
      assert.deepEqual(lintFile(file, root), []);
    }));

  it('ignores exempt tasks (capability discovery, test control, account sync)', () =>
    withTempRoot((root) => {
      const file = writeYaml(root, 'exempt.yaml', {
        id: 'test',
        phases: [
          {
            steps: [
              { id: 'caps', task: 'get_adcp_capabilities', sample_request: {} },
              { id: 'fmts', task: 'list_creative_formats', sample_request: {} },
              { id: 'sync', task: 'sync_accounts', sample_request: { accounts: [] } },
              { id: 'ctrl', task: 'comply_test_controller', sample_request: {} },
            ],
          },
        ],
      });
      assert.deepEqual(lintFile(file, root), []);
    }));

  it('accepts the account.brand shape', () =>
    withTempRoot((root) => {
      const file = writeYaml(root, 'acct.yaml', {
        id: 'test',
        phases: [
          {
            steps: [
              {
                id: 'upd',
                task: 'update_media_buy',
                stateful: true,
                sample_request: {
                  account: { brand: { domain: 'acme.example' }, operator: 'pinnacle.com' },
                  media_buy_id: 'mb-1',
                  paused: true,
                },
              },
            ],
          },
        ],
      });
      assert.deepEqual(lintFile(file, root), []);
    }));

  it('ignores steps with no task (malformed storyboards are caught elsewhere)', () =>
    withTempRoot((root) => {
      const file = writeYaml(root, 'malformed.yaml', {
        id: 'test',
        phases: [{ steps: [{ id: 'broken' }] }],
      });
      assert.deepEqual(lintFile(file, root), []);
    }));
});

describe('lintScoping', () => {
  it('walks a directory tree and returns violations from all files', () =>
    withTempRoot((root) => {
      writeYaml(root, 'one/bad.yaml', {
        id: 'one',
        phases: [{ steps: [{ id: 'r', task: 'get_media_buys', sample_request: {} }] }],
      });
      writeYaml(root, 'two/bad.yaml', {
        id: 'two',
        phases: [{ steps: [{ id: 'u', task: 'update_media_buy', sample_request: {} }] }],
      });
      writeYaml(root, 'three/ok.yaml', {
        id: 'three',
        phases: [{ steps: [{ id: 'c', task: 'create_media_buy', sample_request: { brand: { domain: 'x.example' } } }] }],
      });
      const hits = lintScoping(root);
      assert.equal(hits.length, 2);
      const ids = hits.map((h) => h.step).sort();
      assert.deepEqual(ids, ['r', 'u']);
    }));

  it('passes on the real compliance source tree', () => {
    const realRoot = path.join(__dirname, '..', 'static', 'compliance', 'source');
    const hits = lintScoping(realRoot);
    assert.deepEqual(
      hits,
      [],
      `Real source tree has ${hits.length} scoping violation(s) — run npm run build:compliance for the report.`
    );
  });
});

describe('task sets', () => {
  it('TENANT_SCOPED_TASKS and EXEMPT_FROM_LINT are disjoint', () => {
    for (const t of TENANT_SCOPED_TASKS) {
      assert.equal(EXEMPT_FROM_LINT.has(t), false, `${t} in both sets`);
    }
  });

  it('TENANT_SCOPED_TASKS includes the CRUD tasks exercised in #2236', () => {
    for (const t of ['create_collection_list', 'get_collection_list', 'update_collection_list', 'delete_collection_list', 'list_collection_lists']) {
      assert.equal(TENANT_SCOPED_TASKS.has(t), true, `${t} should be tenant-scoped`);
    }
  });
});
