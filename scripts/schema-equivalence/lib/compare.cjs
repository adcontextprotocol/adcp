'use strict';

/**
 * Compares two schema trees: canonical-form differences without rewrite
 * rules (class 1), with the guarded rewrite rules (class 2), and the
 * informational channel (`default`, `x-*`, keywords Ajv ignores).
 */

const { Graph } = require('./graph.cjs');
const { colorGraph } = require('./color.cjs');
const { Differ } = require('./diff.cjs');
const { applyRules } = require('./rewrite.cjs');
const { isRootFile } = require('./tree.cjs');
const { assertCoversAjv } = require('./keywords.cjs');
const { ruleKeywords } = require('./ajv.cjs');

assertCoversAjv(ruleKeywords());

function rootFiles(tree) {
  return [...tree.files.keys()].filter(isRootFile).sort();
}

function buildGraph(base, head, pairs, annotated) {
  const graph = new Graph({ annotated });
  graph.addSide('base', base, [...new Set(pairs.map(p => p.baseRel).filter(r => base.files.has(r)))]);
  graph.addSide('head', head, [...new Set(pairs.map(p => p.headRel).filter(r => head.files.has(r)))]);
  graph.finalize();
  return graph;
}

function diffAll(graph, pairs) {
  const rootIds = [];
  const refs = pairs.map(p => {
    const a = graph.rootRef('base', p.baseRel);
    const b = graph.rootRef('head', p.headRel);
    if (a) rootIds.push(a.n);
    if (b) rootIds.push(b.n);
    return { name: p.name, a, b };
  });
  const color = colorGraph(graph, rootIds);
  const differ = new Differ(graph, color);
  const entries = [];
  const changedRoots = [];
  const addedRoots = [];
  for (const { name, a, b } of refs) {
    if (a && b && color.get(a.n) === color.get(b.n)) continue;
    // A root that only the head publishes changes no existing root's payloads;
    // it is listed separately. A removed root is a difference.
    if (!a && b) {
      addedRoots.push(name);
      continue;
    }
    changedRoots.push(name);
    entries.push(...differ.diffRoot(name, a, b));
  }
  return { entries, color, changedRoots, addedRoots };
}

/** Root pairs for two trees: every root file, paired by path. */
function defaultPairs(base, head) {
  return [...new Set([...rootFiles(base), ...rootFiles(head)])].sort().map(rel => ({ name: rel, baseRel: rel, headRel: rel }));
}

/**
 * Returns {
 *   roots, class, entries (semantic, after rules when class >= 2),
 *   entriesWithoutRules, rewrites, info, problems, timings
 * }
 */
function compare(base, head, { rules = true, info = true, pairs = defaultPairs(base, head) } = {}) {
  const t0 = Date.now();
  const timings = {};
  const roots = pairs;

  const graph = buildGraph(base, head, pairs, false);
  timings.build_ms = Date.now() - t0;
  let t = Date.now();
  const plain = diffAll(graph, roots);
  timings.diff_ms = Date.now() - t;

  let entries = plain.entries;
  let changedRoots = plain.changedRoots;
  let rewrites = [];
  let cls = plain.entries.length === 0 ? 1 : 3;
  if (plain.entries.length && rules) {
    t = Date.now();
    rewrites = applyRules(graph, plain.color);
    const ruled = diffAll(graph, roots);
    timings.rules_ms = Date.now() - t;
    entries = ruled.entries;
    changedRoots = ruled.changedRoots;
    if (entries.length === 0) cls = 2;
  }

  let infoEntries = [];
  if (info) {
    t = Date.now();
    const annotated = buildGraph(base, head, pairs, true);
    infoEntries = diffAll(annotated, roots).entries.filter(e => e.info);
    timings.info_ms = Date.now() - t;
  }
  timings.total_ms = Date.now() - t0;
  return {
    roots: roots.length,
    class: cls,
    entries,
    changedRoots,
    addedRoots: plain.addedRoots,
    entriesWithoutRules: plain.entries,
    rewrites,
    info: infoEntries,
    problems: graph.problems,
    timings,
  };
}

module.exports = { compare, rootFiles, defaultPairs };
