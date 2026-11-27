'use strict';

/**
 * Delta manifests composed along a range of commits.
 *
 * A series can give each commit its own manifest. Compared as a whole range,
 * the lines of such a series do not match the range's differences one for
 * one: a later commit can change a site an earlier line describes (a bound
 * set by one commit and lowered by the next), and a merge can change a value
 * inside one (a guard ported into a union another commit added). The
 * expected difference at a site is the composition of the commits' changes
 * there, in commit order: the first commit's old value, the last one's new
 * value.
 *
 * The composition is checked one commit at a time rather than on rendered
 * values. A rendered value names shared nodes by the location where the
 * render first met them, so the same schema renders differently once an
 * earlier commit extracts a definition, and a merge's change can sit inside
 * a value another line declares. So each commit of the range is compared
 * with its first parent:
 *
 *   - A commit that adds or changes a manifest file must show exactly that
 *     file's lines (as the range's head writes them), with their sides.
 *   - Any other commit must show no difference.
 *   - A merge's net effect against its first parent is part of the chain as
 *     it is: it brings changes the merged branch already carries, and the
 *     resolution the merge records.
 *
 * When every commit passes, the range's differences are the composition of
 * declared changes, because each difference between the range's base and
 * head arises in some commit and every commit's differences are declared.
 *
 * Side is a property of the roots a commit's change reaches in that commit.
 * A later commit can make the same site reachable from roots on the other
 * side; that commit's own differences are then checked against its own
 * lines. So the range reports such a widening as a note, not a failure.
 */

const { git, loadFromRef, isRootFile, SOURCE_PREFIX } = require('./tree.cjs');
const { compare } = require('./compare.cjs');
const { matchManifest, siteOf } = require('./manifest.cjs');
const { refTarget } = require('./graph.cjs');

const DIST_PREFIX = 'dist/schemas/';

/** Document keys (src:<rel>, dist:<rel>) whose files differ between two commits. */
function changedDocs(repo, from, to) {
  const out = new Set();
  for (const f of git(repo, ['diff', '--name-only', from, to, '--', SOURCE_PREFIX, DIST_PREFIX]).toString('utf8').split('\n')) {
    if (f.startsWith(SOURCE_PREFIX)) out.add(`src:${f.slice(SOURCE_PREFIX.length)}`);
    else if (f.startsWith(DIST_PREFIX)) out.add(`dist:${f.slice(DIST_PREFIX.length)}`);
  }
  return out;
}

const depsCache = new WeakMap();

/** For one tree: document key -> the document keys its `$ref`s name. */
function refDeps(tree) {
  if (depsCache.has(tree)) return depsCache.get(tree);
  const deps = new Map();
  for (const [rel, doc] of tree.files) {
    const key = `src:${rel}`;
    const out = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === '$ref' && typeof x === 'string') {
            const t = refTarget(key, x);
            if (t) out.add(t.doc);
          } else walk(x);
        }
      }
    };
    walk(doc);
    deps.set(key, out);
  }
  depsCache.set(tree, deps);
  return deps;
}

/**
 * The root files whose schema can differ between two trees: those that reach
 * a changed document through `$ref`s in either tree. Every other root reaches
 * only byte-identical documents, so its canonical form is the same.
 */
function affectedRoots(base, head, changed) {
  // Released documents reference each other, and only source documents are
  // indexed: a changed release compares every root.
  if ([...changed].some(d => d.startsWith('dist:'))) {
    return [...new Set([...base.files.keys(), ...head.files.keys()])].filter(isRootFile).sort();
  }
  const users = new Map(); // document -> documents that reference it
  for (const tree of [base, head]) {
    for (const [from, targets] of refDeps(tree)) {
      for (const t of targets) {
        if (!users.has(t)) users.set(t, new Set());
        users.get(t).add(from);
      }
    }
  }
  const seen = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const d = queue.pop();
    for (const u of users.get(d) || []) {
      if (!seen.has(u)) {
        seen.add(u);
        queue.push(u);
      }
    }
  }
  return [...seen].filter(d => d.startsWith('src:')).map(d => d.slice(4)).filter(isRootFile).sort();
}

function parentsOf(repo, commit) {
  return git(repo, ['rev-list', '--parents', '-n', '1', commit]).toString('utf8').trim().split(' ').slice(1);
}

/**
 * The commits of base..head in commit order, each with its parents. When the
 * head is a merge into the base (CI compares a PR's merge commit with its
 * first parent), the merge itself is left out: its net effect is the range.
 */
function rangeCommits(repo, base, head) {
  const list = git(repo, ['rev-list', '--reverse', '--topo-order', `${base}..${head}`]).toString('utf8').split('\n').filter(Boolean);
  const out = list.map(commit => ({ commit, parents: parentsOf(repo, commit) }));
  const last = out[out.length - 1];
  if (last && last.commit === head && last.parents.length > 1 && last.parents[0] === base) out.pop();
  return out;
}

/** Files under `dir` a commit adds or changes against its first parent. */
function touchedFiles(repo, c, dir) {
  if (!c.parents.length) return [];
  return git(repo, ['diff', '--name-only', '--diff-filter=AM', c.parents[0], c.commit, '--', dir]).toString('utf8').split('\n').filter(Boolean);
}

/**
 * Checks a range commit by commit. `files` are the manifest files (repo
 * paths) the range adds or changes; `changes` their lines, each with `file`
 * (repo path) and its range-wide `index`. Returns null when the range has
 * fewer than two commits, else { ok, steps, unowned, problems }.
 *
 * Steps, in order:
 *
 *   - A merged branch whose own range passes: when a merge's other parent
 *     is the head of a range that starts at the base and whose differences
 *     equal the manifests that range adds (a stacked PR merged in, with one
 *     manifest for all of its commits), that range is one step and its
 *     commits are not checked again.
 *   - A segment: the commits since the previous segment, along first
 *     parents, up to and including a commit that adds or changes a manifest
 *     file. The segment's differences, from the parent of its first commit
 *     to that commit, must equal the lines of the manifests its commits
 *     add. A segment of one commit is a commit with its own manifest.
 *   - A merge: its net effect against its first parent, taken as it is.
 *
 * Commits after the last manifest form an open segment, which must show no
 * difference, as must a segment that a merge or a change of line cuts short.
 */
function checkChain({ repo, base, head, files, changes, dir, rules }) {
  const commits = rangeCommits(repo, base, head);
  if (commits.length < 2) return null;
  const byId = new Map(commits.map(c => [c.commit, c]));
  const touched = new Map(commits.map(c => [c.commit, touchedFiles(repo, c, dir).filter(f => files.includes(f))]));
  const problems = [];
  // A few trees stay loaded: consecutive steps share them.
  const trees = new Map();
  const tree = (commit) => {
    if (trees.has(commit)) {
      const t = trees.get(commit);
      trees.delete(commit);
      trees.set(commit, t);
      return t;
    }
    const t = loadFromRef(repo, commit);
    trees.set(commit, t);
    if (trees.size > 4) trees.delete(trees.keys().next().value);
    return t;
  };
  // Differences between two commits, comparing only the roots that reach a
  // changed document, without the informational channel.
  const diff = (from, to) => {
    const changed = changedDocs(repo, from, to);
    if (!changed.size) return [];
    const roots = affectedRoots(tree(from), tree(to), changed);
    if (!roots.length) return [];
    return compare(tree(from), tree(to), { rules, info: false, pairs: roots.map(rel => ({ name: rel, baseRel: rel, headRel: rel })) }).entries;
  };
  const subject = commit => git(repo, ['log', '-1', '--format=%s', commit]).toString('utf8').trim();
  const steps = [];
  const owned = new Set(); // manifest files whose lines a step checked

  // Merged branches whose own range from the base passes, latest first.
  const covered = new Set();
  for (const m of [...commits].reverse()) {
    if (m.parents.length < 2) continue;
    const q = m.parents[1];
    if (!byId.has(q) || covered.has(q)) continue;
    const inside = git(repo, ['rev-list', `${base}..${q}`]).toString('utf8').split('\n').filter(Boolean);
    const subFiles = [...new Set(inside.flatMap(c => touched.get(c) || []))];
    if (!subFiles.length) continue;
    const lines = changes.filter(ch => subFiles.includes(ch.file));
    const entries = diff(base, q);
    const match = matchManifest(entries, { changes: lines });
    if (!match.ok) continue;
    for (const c of inside) covered.add(c);
    subFiles.forEach(f => owned.add(f));
    steps.push({ kind: 'branch', commit: q, parent: base, subject: subject(q), merge: false, commits: inside, lines, match, entries });
  }

  // Segments and merges among the other commits.
  let open = []; // commits of the open segment, along first parents
  const close = (lines, why) => {
    if (!open.length) return;
    const last = open[open.length - 1];
    const parent = open[0].parents[0];
    const entries = diff(parent, last.commit);
    const match = matchManifest(entries, { changes: lines });
    if (why && !match.ok && match.extra.length) problems.push(`${why}: ${open.length} commit${open.length === 1 ? '' : 's'} ending at ${last.commit.slice(0, 10)} show differences no manifest declares`);
    steps.push({ kind: 'segment', commit: last.commit, parent, subject: subject(last.commit), merge: false, commits: open.map(c => c.commit), lines, match, entries });
    open = [];
  };
  for (const c of commits) {
    if (covered.has(c.commit)) continue;
    if (c.parents.length > 1) {
      close([], 'a merge cuts the segment short');
      for (const f of touched.get(c.commit)) if (!owned.has(f)) problems.push(`${f} arrives through merge ${c.commit.slice(0, 10)}, so no commit shows its lines`);
      steps.push({ kind: 'merge', commit: c.commit, parent: c.parents[0], subject: subject(c.commit), merge: true, commits: [c.commit], entries: diff(c.parents[0], c.commit) });
      continue;
    }
    if (open.length && open[open.length - 1].commit !== c.parents[0]) close([], 'the next commit does not build on the segment');
    open.push(c);
    const own = touched.get(c.commit).filter(f => !owned.has(f));
    if (own.length) {
      own.forEach(f => owned.add(f));
      close(changes.filter(ch => own.includes(ch.file)), null);
    }
  }
  close([], 'commits after the last manifest');
  const unowned = changes.filter(ch => !owned.has(ch.file));
  const ok = problems.length === 0 && unowned.length === 0 && steps.every(s => s.merge || s.match.ok);
  return { ok, steps, unowned, problems };
}

/**
 * Notes for lines whose site the whole range reaches on more sides than the
 * line's own commit did: `rangeMatch` is the range-wide match of all lines.
 */
function sideNotes(rangeMatch, chain) {
  const stepSide = new Map();
  for (const s of chain.steps) if (!s.merge) for (const m of s.match.matched) stepSide.set(m.change.index, { side: m.side, commit: s.commit });
  const notes = [];
  for (const p of rangeMatch.problems) {
    if (!/^side is/.test(p.problem)) continue;
    const own = stepSide.get(p.change.index);
    const range = rangeMatch.matched.find(m => m.change.index === p.change.index);
    if (!own || !range || own.side !== p.change.side) continue;
    notes.push({
      index: p.change.index,
      site: p.change.location || `${p.change.root} ${p.change.pointer}`,
      declared: p.change.side,
      range_side: range.side,
      commit: own.commit,
      note: `the range reaches this site on side "${range.side}"; in ${own.commit.slice(0, 10)}, the commit that declares it, the change reaches side "${own.side}"`,
    });
  }
  return notes;
}

/** Report fields for a chain check, in the shape of a manifest match. */
function chainReport(chain, rangeMatch) {
  const tag = (s, x) => ({ ...x, commit: s.commit });
  const lineSteps = chain.steps.filter(s => !s.merge);
  return {
    mode: 'chain',
    ok: chain.ok,
    matched: lineSteps.flatMap(s => s.match.matched.map(m => tag(s, m))),
    extra: lineSteps.flatMap(s => s.match.extra.map(e => tag(s, e))),
    missing: [...lineSteps.flatMap(s => s.match.missing.map(m => tag(s, m))), ...chain.unowned],
    problems: [
      ...lineSteps.flatMap(s => s.match.problems.map(p => tag(s, p))),
      ...chain.problems.map(problem => ({ change: null, problem })),
    ],
    steps: chain.steps.map(s => ({
      kind: s.kind,
      commit: s.commit,
      parent: s.parent,
      subject: s.subject,
      merge: s.merge,
      commits: s.commits.length,
      entries: s.entries.length,
      sites: new Set(s.entries.map(siteOf)).size,
      lines: s.merge ? undefined : s.lines.map(l => l.index),
      ok: s.merge ? true : s.match.ok,
    })),
    range: { extra: rangeMatch.extra.length, missing: rangeMatch.missing.length, problems: rangeMatch.problems.length },
    notes: sideNotes(rangeMatch, chain),
  };
}

module.exports = { checkChain, chainReport, rangeCommits };
