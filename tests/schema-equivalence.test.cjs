'use strict';

/**
 * Schema equivalence check, exercised through its CLI on the fixture pairs
 * in scripts/schema-equivalence/test/fixtures. Each pair differs for exactly
 * one reason, stated in its expect.json `why`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'schema-equivalence', 'cli.cjs');
const FIXTURES = path.join(__dirname, '..', 'scripts', 'schema-equivalence', 'test', 'fixtures');

function run(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--json', '-', '--quiet'], { cwd, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      const code = err ? err.code : 0;
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        // left null; the assertion below reports stderr
      }
      resolve({ code, report, stderr });
    });
  });
}

describe('schema-equivalence CLI fixtures', { concurrency: 8 }, () => {
  for (const name of fs.readdirSync(FIXTURES).sort()) {
    const dir = path.join(FIXTURES, name);
    const expect = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf8'));
    it(`${name}: ${expect.why}`, async () => {
      const { code, report, stderr } = await run(['--base-dir', 'base', '--head-dir', 'head', ...(expect.args || [])], dir);
      assert.ok(report, `no JSON report; stderr: ${stderr}`);
      const c = report.compare;
      assert.equal(c.class, expect.class, `proof class; entries: ${JSON.stringify(c.entries, null, 1)}`);
      assert.equal(code, expect.exit, `exit code; failures: ${report.failures.join('; ')}`);
      if (expect.class === 1) assert.equal(c.entriesWithoutRules.length, 0);
      if (expect.rule) assert.ok(c.rewrites.some(r => r.rule === expect.rule), `rule ${expect.rule} fired`);
      if (expect.keyword) assert.ok(c.entries.some(e => e.keyword === expect.keyword), `an entry for ${expect.keyword}: ${JSON.stringify(c.entries)}`);
      if (expect.entries !== undefined) assert.equal(c.entries.length, expect.entries);
      if (expect.info) assert.ok(c.info.some(e => e.keyword === expect.info), `informational entry for ${expect.info}`);
      if (expect.infoEntries !== undefined) assert.equal(c.info.length, expect.infoEntries, JSON.stringify(c.info, null, 1));
      if (expect.addedRoots) assert.deepEqual(c.addedRoots, expect.addedRoots);
      if (expect.manifestOk !== undefined) assert.equal(report.manifest.ok, expect.manifestOk);
      if (expect.extra !== undefined) assert.equal(report.manifest.extra.length, expect.extra);
      if (expect.missing !== undefined) assert.equal(report.manifest.missing.length, expect.missing);
      if (expect.corpusChanges !== undefined) assert.equal(report.corpus.changes.length, expect.corpusChanges);
      if (expect.probeHits !== undefined) assert.equal(report.corpus.probe_hits.length, expect.probeHits, JSON.stringify(report.corpus.probe_hits));
      if (expect.witnesses !== undefined) {
        assert.equal(report.witnesses.filter(w => w.ok).length, expect.witnesses, JSON.stringify(report.witnesses, null, 1));
      }
    });
  }
});

describe('schema-equivalence CLI on git refs', () => {
  it('HEAD against itself reports zero differences', async () => {
    const { code, report, stderr } = await run(['--base', 'HEAD', '--head', 'HEAD'], path.join(__dirname, '..'));
    assert.ok(report, stderr);
    assert.equal(code, 0);
    assert.equal(report.compare.entries.length, 0);
    assert.equal(report.compare.info.length, 0);
    assert.ok(report.compare.roots > 1000, 'every published root compared');
  });
});
