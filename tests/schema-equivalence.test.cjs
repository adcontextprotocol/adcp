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
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');

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
      if (expect.observed !== undefined) assert.deepEqual(report.witnesses[0].observed, expect.observed);
      if (expect.witnesses !== undefined) {
        assert.equal(report.witnesses.filter(w => w.ok).length, expect.witnesses, JSON.stringify(report.witnesses, null, 1));
      }
    });
  }
});

const ONEOF_FIXTURES = path.join(__dirname, '..', 'scripts', 'schema-equivalence', 'test', 'oneof-fixtures');

describe('schema-equivalence oneof check', { concurrency: 4 }, () => {
  for (const name of fs.readdirSync(ONEOF_FIXTURES).sort()) {
    const dir = path.join(ONEOF_FIXTURES, name);
    const expect = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf8'));
    it(`${name}: ${expect.why}`, async () => {
      const { code, report, stderr } = await run(['oneof', '--dir', dir], dir);
      assert.ok(report, `no JSON report; stderr: ${stderr}`);
      assert.deepEqual(report.counts, expect.counts, JSON.stringify(report.sites, null, 1));
      assert.equal(code, expect.exit);
      const byLocation = new Map(report.sites.map(s => [s.location, s]));
      for (const [loc, rules] of Object.entries(expect.rules || {})) assert.deepEqual(byLocation.get(loc).rules, rules, loc);
      for (const [loc, payload] of Object.entries(expect.witness || {})) {
        const site = byLocation.get(loc);
        assert.equal(site.result, 'W', loc);
        assert.deepEqual(site.witness, payload, loc);
        assert.ok(site.passing.length >= 2, 'the witness matches two or more branches');
      }
      const reportOnly = await run(['oneof', '--dir', dir, '--report-only'], dir);
      assert.equal(reportOnly.code, 0, '--report-only exits 0');
      assert.deepEqual(reportOnly.report.counts, expect.counts);
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

  it('--manifest auto reads the delta manifest from the head ref, not the working tree', async () => {
    // A scratch repository whose working tree stays at the base commit, so the
    // head's .schema-deltas file exists only in git objects.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-equivalence-'));
    try {
      const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
      const fixture = path.join(FIXTURES, 'c3-tighten-manifest');
      const src = path.join(repo, 'static', 'schemas', 'source');
      g('init', '-q', '-b', 'main');
      fs.mkdirSync(src, { recursive: true });
      fs.copyFileSync(path.join(fixture, 'base', 'a-request.json'), path.join(src, 'a-request.json'));
      g('add', '.');
      g('commit', '-q', '-m', 'base');
      const base = g('rev-parse', 'HEAD');
      fs.copyFileSync(path.join(fixture, 'head', 'a-request.json'), path.join(src, 'a-request.json'));
      fs.mkdirSync(path.join(repo, '.schema-deltas'));
      fs.copyFileSync(path.join(fixture, 'manifest.yaml'), path.join(repo, '.schema-deltas', 'tighten.yaml'));
      g('add', '.');
      g('commit', '-q', '-m', 'head');
      const head = g('rev-parse', 'HEAD');
      g('checkout', '-q', base);
      assert.ok(!fs.existsSync(path.join(repo, '.schema-deltas', 'tighten.yaml')), 'the manifest is not in the working tree');
      const { code, report, stderr } = await run(['--repo', repo, '--base', base, '--head', head, '--manifest', 'auto', '--witness'], repo);
      assert.ok(report, stderr);
      assert.deepEqual(report.manifest.files, ['.schema-deltas/tighten.yaml']);
      assert.equal(report.manifest.ok, true);
      assert.equal(code, 0, report.failures.join('; '));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
