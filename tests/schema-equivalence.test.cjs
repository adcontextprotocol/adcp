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
      if (expect.location) assert.ok(c.entries.some(e => e.keyword === expect.keyword && e.head_location === expect.location), `an entry for ${expect.keyword} at ${expect.location}: ${JSON.stringify(c.entries.map(e => [e.keyword, e.head_location]))}`);
      if (expect.attribution) assert.ok(report.witnesses.some(w => (w.payloads || []).some(p => p.from === 'recorded' && p.attribution === expect.attribution)), `a recorded witness attributed to the ${expect.attribution}: ${JSON.stringify(report.witnesses)}`);
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

// Reads a row of the oneof Markdown table as GitHub does: a pipe ends a cell
// unless a backslash precedes it, `\|` reads as `|`, and a code span keeps its
// backslashes.
const tableRow = line => line.slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const codeSpan = text => /^(`+) ?(.*?) ?\1$/.exec(text)[2];

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
      const markdown = execFileSync(process.execPath, [CLI, 'oneof', '--dir', dir, '--report-only'], { cwd: dir }).toString();
      const rows = markdown.split('\n').filter(line => /^\| [PWU] \|/.test(line)).map(tableRow);
      assert.equal(rows.length, report.sites.length, markdown);
      for (const [result, location, detail] of rows) {
        const site = byLocation.get(codeSpan(location));
        assert.ok(site, `a site for the row ${location}`);
        if (result === 'W') assert.deepEqual(JSON.parse(codeSpan(detail.replace(/^.*? accept /, ''))), site.witness);
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

// A scratch repository with schemas under static/schemas/source and delta
// manifests under .schema-deltas, for checks that span several commits.
function scratchRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-equivalence-chain-'));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
  g('init', '-q', '-b', 'main');
  const schema = (rel, body) => {
    const f = path.join(repo, 'static', 'schemas', 'source', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `/schemas/${rel}`, ...body }, null, 2));
  };
  const manifest = (name, changes) => {
    fs.mkdirSync(path.join(repo, '.schema-deltas'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.schema-deltas', `${name}.yaml`), JSON.stringify({ title: name, changes }, null, 2));
  };
  const commit = (message) => {
    g('add', '-A');
    g('commit', '-q', '-m', message);
    return g('rev-parse', 'HEAD');
  };
  return { repo, g, schema, manifest, commit, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

describe('schema-equivalence CLI on a range of commits', () => {
  const name = maxLength => ({ type: 'object', properties: { name: { type: 'string', ...(maxLength ? { maxLength } : {}) } } });

  it('two commits that change one site compose: the first old value, the last new one', async () => {
    const r = scratchRepo();
    try {
      r.schema('a-request.json', name());
      const base = r.commit('base');
      r.schema('a-request.json', name(10));
      r.manifest('first', [{ location: 'a-request.json#/properties/name', keyword: 'maxLength', new: 10, direction: 'tighten', side: 'request' }]);
      r.commit('bound the name');
      r.schema('a-request.json', name(8));
      r.manifest('second', [{ location: 'a-request.json#/properties/name', keyword: 'maxLength', old: 10, new: 8, direction: 'tighten', side: 'request' }]);
      const head = r.commit('lower the bound');
      const { code, report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto', '--witness'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      assert.deepEqual(report.manifest.range, { extra: 1, missing: 2, problems: 0 }, 'the range alone shows absent -> 8');
      assert.equal(report.manifest.ok, true, JSON.stringify(report.manifest.steps));
      assert.equal(report.witnesses.filter(w => w.ok).length, 2, JSON.stringify(report.witnesses));
      // Neither line matches the range (absent -> 8), so each witness comes from its own commit.
      assert.ok(report.witnesses.every(w => w.from !== 'range' && /^[0-9a-f]{40}$/.test(w.from)), JSON.stringify(report.witnesses.map(w => w.from)));
      assert.equal(code, 0, report.failures.join('; '));
    } finally {
      r.cleanup();
    }
  });

  it('a commit whose change no line declares fails the composed check', async () => {
    const r = scratchRepo();
    try {
      r.schema('a-request.json', name());
      const base = r.commit('base');
      r.schema('a-request.json', name(10));
      r.manifest('first', [{ location: 'a-request.json#/properties/name', keyword: 'maxLength', new: 10, direction: 'tighten', side: 'request' }]);
      r.commit('bound the name');
      r.schema('a-request.json', name(8));
      const head = r.commit('lower the bound without a manifest');
      const { code, report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      assert.equal(report.manifest.ok, false);
      assert.deepEqual(report.manifest.extra.map(e => [e.commit, e.keyword, e.old, e.new]), [[head, 'maxLength', 10, 8]]);
      assert.ok(report.manifest.problems.some(p => /commits after the last manifest/.test(p.problem)), JSON.stringify(report.manifest.problems));
      assert.equal(code, 1);
    } finally {
      r.cleanup();
    }
  });

  it('a manifest covers the commits before it since the previous manifest', async () => {
    const r = scratchRepo();
    try {
      r.schema('a-request.json', name());
      const base = r.commit('base');
      r.schema('a-request.json', name(10));
      r.commit('bound the name');
      r.manifest('first', [{ location: 'a-request.json#/properties/name', keyword: 'maxLength', new: 10, direction: 'tighten', side: 'request' }]);
      r.commit('add the manifest for the bound');
      r.schema('a-request.json', name(8));
      r.manifest('second', [{ location: 'a-request.json#/properties/name', keyword: 'maxLength', old: 10, new: 8, direction: 'tighten', side: 'request' }]);
      const head = r.commit('lower the bound');
      const { code, report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto', '--witness'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      assert.deepEqual(report.manifest.steps.map(s => [s.kind, s.commits, s.lines.length, s.ok]), [['segment', 2, 1, true], ['segment', 1, 1, true]]);
      assert.equal(report.manifest.ok, true, JSON.stringify(report.manifest.problems));
      assert.equal(code, 0, report.failures.join('; '));
    } finally {
      r.cleanup();
    }
  });

  it('a stacked branch merged in, with one manifest after a merge of the base, passes as its own range', async () => {
    const r = scratchRepo();
    try {
      const a = minLength => ({ type: 'object', properties: { name: { type: 'string', ...(minLength ? { minLength } : {}) } } });
      r.schema('a-request.json', a());
      r.schema('c-request.json', { type: 'object', properties: { code: { type: 'string' } } });
      r.commit('start');
      r.g('checkout', '-q', '-b', 'stacked');
      r.schema('a-request.json', a(1));
      const p1 = r.commit('stacked: require a name');
      r.g('checkout', '-q', 'main');
      r.schema('c-request.json', { type: 'object', properties: { code: { type: 'string', maxLength: 8 } } });
      const base = r.commit('main moves on');
      r.g('checkout', '-q', 'stacked');
      r.g('merge', '-q', '--no-edit', 'main');
      r.manifest('stacked', [{ location: 'a-request.json#/properties/name', keyword: 'minLength', new: 1, direction: 'tighten', side: 'request' }]);
      r.commit('stacked: add its manifest');
      r.g('checkout', '-q', '-b', 'series', p1);
      r.schema('a-request.json', a(2));
      r.manifest('series', [{ location: 'a-request.json#/properties/name', keyword: 'minLength', old: 1, new: 2, direction: 'tighten', side: 'request' }]);
      r.commit('series: raise the minimum');
      r.g('merge', '-q', '--no-edit', 'stacked');
      const head = r.g('rev-parse', 'HEAD');
      const { code, report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto', '--witness'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      assert.deepEqual(report.manifest.steps.map(s => [s.kind, s.commits, s.ok]), [['branch', 3, true], ['segment', 1, true], ['merge', 1, true]]);
      assert.equal(report.manifest.ok, true, JSON.stringify(report.manifest.problems));
      assert.equal(code, 0, report.failures.join('; '));
    } finally {
      r.cleanup();
    }
  });

  it('a merge in the range counts with its net effect, including its resolution', async () => {
    const r = scratchRepo();
    try {
      r.schema('a-request.json', name());
      r.schema('b-response.json', { type: 'object', properties: { code: { type: 'string' } } });
      r.commit('start');
      r.g('checkout', '-q', '-b', 'side');
      r.schema('b-response.json', { type: 'object', properties: { code: { type: 'string', minLength: 1 } } });
      const base = r.commit('the merged branch bounds the code');
      r.g('checkout', '-q', 'main');
      r.schema('a-request.json', name(10));
      r.manifest('first', [{ location: 'a-request.json#/properties/name', keyword: 'maxLength', new: 10, direction: 'tighten', side: 'request' }]);
      r.commit('bound the name');
      r.g('merge', '-q', '--no-commit', 'side');
      // The resolution ports the merged branch's rule to the name.
      r.schema('a-request.json', { type: 'object', properties: { name: { type: 'string', maxLength: 10, minLength: 1 } } });
      const head = r.commit('merge side');
      const { code, report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto', '--witness'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      assert.deepEqual(report.manifest.range, { extra: 1, missing: 0, problems: 0 }, 'the range alone shows the ported minLength undeclared');
      assert.deepEqual(report.manifest.steps.map(s => s.merge), [false, true]);
      assert.equal(report.manifest.ok, true, JSON.stringify(report.manifest.steps));
      assert.equal(code, 0, report.failures.join('; '));
    } finally {
      r.cleanup();
    }
  });

  it('a commit\'s change two $refs away from a root is found, and a commit without schema changes joins the next segment', async () => {
    const r = scratchRepo();
    try {
      r.schema('leaf.json', { type: 'string' });
      r.schema('mid.json', { type: 'object', properties: { leaf: { $ref: '/schemas/leaf.json' } } });
      r.schema('top-request.json', { type: 'object', properties: { mid: { $ref: '/schemas/mid.json' } } });
      r.schema('other-request.json', { type: 'object', properties: { note: { type: 'string' } } });
      const base = r.commit('base');
      r.schema('leaf.json', { type: 'string', maxLength: 64 });
      r.manifest('first', [{ location: 'leaf.json#', keyword: 'maxLength', new: 64, direction: 'tighten', side: 'request' }]);
      r.commit('bound the leaf');
      fs.writeFileSync(path.join(r.repo, 'NOTES.md'), 'no schema change\n');
      r.commit('notes only');
      r.schema('leaf.json', { type: 'string', maxLength: 32 });
      r.schema('other-request.json', { type: 'object', properties: { note: { type: 'string', maxLength: 10 } } });
      r.manifest('second', [
        { location: 'leaf.json#', keyword: 'maxLength', old: 64, new: 32, direction: 'tighten', side: 'request' },
        { location: 'other-request.json#/properties/note', keyword: 'maxLength', new: 10, direction: 'tighten', side: 'request' },
      ]);
      const head = r.commit('lower the leaf bound and bound the note');
      const { report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      // leaf.json, mid.json and top-request.json each show the leaf bound;
      // the notes commit joins the segment the last manifest closes.
      assert.deepEqual(report.manifest.steps.map(s => [s.commits, s.entries]), [[1, 3], [2, 4]]);
      assert.equal(report.manifest.ok, true, JSON.stringify(report.manifest.problems));
    } finally {
      r.cleanup();
    }
  });

  it('a site that a later commit makes reachable from the other side keeps each line\'s own side', async () => {
    const r = scratchRepo();
    try {
      const url = pattern => ({ type: 'string', ...(pattern ? { pattern: '^https://' } : {}) });
      r.schema('url.json', url(false));
      r.schema('x-response.json', { type: 'object', properties: { link: { $ref: '/schemas/url.json' } } });
      r.schema('y-request.json', { type: 'object', properties: { link: { type: 'string' } } });
      const base = r.commit('base');
      r.schema('url.json', url(true));
      r.manifest('first', [{ location: 'url.json#', keyword: 'pattern', new: '^https://', direction: 'tighten', side: 'response' }]);
      r.commit('responses link over https');
      r.schema('y-request.json', { type: 'object', properties: { link: { $ref: '/schemas/url.json' } } });
      r.manifest('second', [{ location: 'url.json#', keyword: 'pattern', new: '^https://', direction: 'tighten', side: 'request' }]);
      const head = r.commit('requests take the shared url');
      const { code, report, stderr } = await run(['--repo', r.repo, '--base', base, '--head', head, '--manifest', 'auto', '--witness'], r.repo);
      assert.ok(report, stderr);
      assert.equal(report.manifest.mode, 'chain');
      assert.deepEqual(report.manifest.range, { extra: 0, missing: 0, problems: 2 }, 'the range alone reaches the site on both sides');
      assert.equal(report.manifest.ok, true, JSON.stringify(report.manifest.problems));
      assert.deepEqual(report.manifest.notes.map(n => [n.index, n.declared, n.range_side]), [[0, 'response', 'both'], [1, 'request', 'both']]);
      // Both lines match the range's differences, so their witnesses come from the range.
      assert.deepEqual(report.witnesses.map(w => [w.index, w.ok, w.from]), [[0, true, 'range'], [1, true, 'range']]);
      assert.equal(code, 0, report.failures.join('; '));
    } finally {
      r.cleanup();
    }
  });
});
