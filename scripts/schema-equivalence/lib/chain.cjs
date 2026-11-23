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

const { git, loadFromRef } = require('./tree.cjs');
const { compare } = require('./compare.cjs');
const { matchManifest, siteOf } = require('./manifest.cjs');

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
 */
function checkChain({ repo, base, head, files, changes, dir, rules }) {
  const commits = rangeCommits(repo, base, head);
  if (commits.length < 2) return null;
  const owner = new Map(); // manifest file -> the first commit that adds or changes it
  for (const c of commits) {
    for (const f of touchedFiles(repo, c, dir)) if (files.includes(f) && !owner.has(f)) owner.set(f, c);
  }
  const problems = [];
  const unowned = changes.filter(ch => !owner.has(ch.file));
  for (const f of files) {
    const c = owner.get(f);
    if (c && c.parents.length > 1) problems.push(`${f} arrives through merge ${c.commit.slice(0, 10)}, so no commit shows its lines`);
  }
  const trees = new Map();
  const tree = (commit) => {
    if (!trees.has(commit)) trees.set(commit, loadFromRef(repo, commit));
    return trees.get(commit);
  };
  const steps = [];
  for (const c of commits) {
    const parent = c.parents[0];
    const result = compare(tree(parent), tree(c.commit), { rules });
    const subject = git(repo, ['log', '-1', '--format=%s', c.commit]).toString('utf8').trim();
    if (c.parents.length > 1) {
      steps.push({ commit: c.commit, parent, subject, merge: true, entries: result.entries });
    } else {
      const lines = changes.filter(ch => owner.get(ch.file) === c);
      const match = matchManifest(result.entries, { changes: lines });
      steps.push({ commit: c.commit, parent, subject, merge: false, lines, match, entries: result.entries });
    }
    // Only the trees a later step compares stay loaded.
    trees.delete(parent);
  }
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
      commit: s.commit,
      parent: s.parent,
      subject: s.subject,
      merge: s.merge,
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
