'use strict';

/**
 * Schema equivalence check against the construct catalog in
 * scripts/schema-equivalence/test/catalog. Each catalog pair carries a
 * verdict that an independent procedure decided (see the catalog README); the
 * tool only runs here, through its CLI in directory mode, and its result is
 * compared with the stored verdict:
 *
 *   - a pair that is not equivalent must get at least one difference entry
 *     for its root (a miss would be a false "equivalent");
 *   - an equivalent pair must get none, unless false-alarms.json lists it,
 *     and then it must still get one, so the list stays exact.
 *
 * The stored witnesses are also checked with the repo's Ajv configuration.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createAjv } = require('../scripts/schema-equivalence/lib/ajv.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'schema-equivalence', 'cli.cjs');
const CATALOG = path.join(__dirname, '..', 'scripts', 'schema-equivalence', 'test', 'catalog');
const FALSE_ALARMS = JSON.parse(fs.readFileSync(path.join(CATALOG, 'false-alarms.json'), 'utf8')).pairs;

function catalogFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return catalogFiles(full);
    return e.name.endsWith('.json') && e.name !== 'false-alarms.json' ? [full] : [];
  }).sort();
}

const PAIRS = catalogFiles(CATALOG).flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).pairs);

function writeSide(dir, files) {
  for (const [rel, doc] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(doc));
  }
}

function runTool(pair) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-equivalence-catalog-'));
  writeSide(path.join(dir, 'base'), pair.base);
  writeSide(path.join(dir, 'head'), pair.head);
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, '--base-dir', 'base', '--head-dir', 'head', '--json', '-', '--quiet'], { cwd: dir, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        // left null; the assertion reports stderr
      }
      resolve({ code: err ? err.code : 0, report, stderr });
    });
  });
}

function rootValidator(files, root) {
  const ajv = createAjv();
  for (const doc of Object.values(files)) ajv.addSchema(doc);
  return ajv.getSchema(`/schemas/${root}`);
}

describe('schema-equivalence construct catalog', { concurrency: os.availableParallelism() }, () => {
  it('lists only equivalent catalog pairs as false alarms', () => {
    const byId = new Map(PAIRS.map(p => [p.id, p]));
    for (const id of Object.keys(FALSE_ALARMS)) {
      assert.ok(byId.has(id), `false-alarms.json names an unknown pair ${id}`);
      assert.equal(byId.get(id).verdict.equivalent, true, `false-alarms.json names a pair that is not equivalent: ${id}`);
    }
  });

  for (const pair of PAIRS) {
    const expect = !pair.verdict.equivalent ? 'difference' : FALSE_ALARMS[pair.id] ? 'difference (known false alarm)' : 'no difference';
    it(`${pair.id}: ${expect}`, async () => {
      const base = rootValidator(pair.base, pair.root);
      const head = rootValidator(pair.head, pair.root);
      for (const w of pair.witnesses || []) {
        assert.equal(base(w.payload), w.base, `witness ${JSON.stringify(w.payload)} on base`);
        assert.equal(head(w.payload), w.head, `witness ${JSON.stringify(w.payload)} on head`);
      }
      const { report, stderr } = await runTool(pair);
      assert.ok(report, `no JSON report; stderr: ${stderr}`);
      assert.deepEqual(report.compare.problems, []);
      const entries = report.compare.entries.filter(e => e.root === pair.root);
      if (!pair.verdict.equivalent) {
        assert.ok(entries.length > 0, 'MISS: the pair is not equivalent, but the tool reports no difference');
      } else if (FALSE_ALARMS[pair.id]) {
        assert.ok(entries.length > 0, 'the tool no longer reports this known false alarm; remove it from false-alarms.json');
      } else {
        assert.deepEqual(entries.map(e => [e.pointer, e.keyword, e.old, e.new]), [], 'the pair is equivalent, but the tool reports a difference');
      }
    });
  }
});
