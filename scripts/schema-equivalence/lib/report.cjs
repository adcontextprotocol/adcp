'use strict';

/** Human-readable report. The JSON report carries the same data in full. */

const { stableStringify } = require('./json.cjs');
const { siteOf } = require('./manifest.cjs');

function short(value, max = 160) {
  if (value === undefined) return '(absent)';
  const s = stableStringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Groups entries by (site, keyword, old, new). */
function groupBySite(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = stableStringify([siteOf(e), e.keyword, e.old, e.new]);
    if (!groups.has(key)) groups.set(key, { site: siteOf(e), keyword: e.keyword, old: e.old, new: e.new, entries: [] });
    groups.get(key).entries.push(e);
  }
  return [...groups.values()];
}

function formatGroups(groups, { maxGroups = 50, maxRoots = 4 } = {}) {
  const lines = [];
  groups.slice(0, maxGroups).forEach((g, i) => {
    lines.push(`  [${i + 1}] ${g.site}  ${g.keyword}`);
    lines.push(`      old: ${short(g.old)}`);
    lines.push(`      new: ${short(g.new)}`);
    const roots = g.entries.slice(0, maxRoots).map(e => `${e.root} ${e.pointer || '/'}`);
    lines.push(`      in ${g.entries.length} root${g.entries.length === 1 ? '' : 's'}: ${roots.join('; ')}${g.entries.length > maxRoots ? '; …' : ''}`);
  });
  if (groups.length > maxGroups) lines.push(`  … ${groups.length - maxGroups} more sites (see the JSON report)`);
  return lines;
}

function formatText(report) {
  const lines = [];
  const { compare: c } = report;
  lines.push(`Schema equivalence: ${report.base.label}${report.base.commit ? ` (${report.base.commit.slice(0, 12)})` : ''} -> ${report.head.label}${report.head.commit ? ` (${report.head.commit.slice(0, 12)})` : ''}`);
  lines.push(`Roots compared: ${c.roots}; roots that differ: ${c.changedRoots.length}; proof class: ${c.class === 1 ? '1 (canonical forms identical)' : c.class === 2 ? '2 (identical after guarded rewrites)' : '3 (differences remain)'}`);
  if (c.problems.length) {
    lines.push(`Problems (${c.problems.length}):`);
    for (const p of c.problems.slice(0, 20)) lines.push(`  ${p.side}: ${p.location}: ${p.problem}`);
  }
  if (c.class >= 2 && c.rewrites.length) {
    const sites = new Set([...c.entriesWithoutRules.map(e => e.base_location), ...c.entriesWithoutRules.map(e => e.head_location)]);
    const relevant = c.rewrites.filter(r => sites.has(r.location));
    const byRule = {};
    for (const r of c.rewrites) byRule[r.rule] = (byRule[r.rule] || 0) + 1;
    lines.push(`Rewrite rules fired: ${Object.entries(byRule).map(([k, v]) => `${k} x${v}`).join(', ')}`);
    for (const r of relevant.slice(0, 20)) lines.push(`  ${r.side} ${r.location}: ${r.rule} (${r.proof})`);
  }
  const groups = groupBySite(c.entries);
  if (groups.length) {
    lines.push(`Differences: ${c.entries.length} entries at ${groups.length} sites`);
    lines.push(...formatGroups(groups));
  } else {
    lines.push('Differences: none');
  }
  if (report.manifest) {
    const m = report.manifest;
    const name = m.files.length ? m.files.join(', ') : '(no delta manifest: no differences are intended)';
    if (m.mode === 'chain') {
      const merges = m.steps.filter(s => s.merge).length;
      lines.push(`Manifest ${name}: the lines do not match the range as a whole (${m.range.extra} undeclared, ${m.range.missing} unmatched), so they are composed commit by commit: ${m.ok ? 'every commit\'s differences equal its own lines' : 'does NOT match'}`);
      lines.push(`  ${m.steps.length} commits; ${merges} merge${merges === 1 ? '' : 's'} taken as their net effect`);
      for (const s of m.steps) {
        const what = s.merge ? `merge, net effect ${s.entries} entries at ${s.sites} sites` : `${s.lines.length} lines, ${s.entries} entries at ${s.sites} sites${s.ok ? '' : ' (does NOT match)'}`;
        lines.push(`  ${s.commit.slice(0, 10)} ${s.subject}: ${what}`);
      }
      for (const n of m.notes) lines.push(`  note, entry ${n.index}: ${n.note}`);
    } else lines.push(`Manifest ${name}: ${m.ok ? 'matches the differences exactly' : 'does NOT match'}`);
    for (const x of m.missing) lines.push(`  missing difference for manifest entry ${x.index}${x.commit ? ` in ${x.commit.slice(0, 10)}` : ''}: ${x.location || `${x.root} ${x.pointer}`} ${x.keyword}`);
    if (m.extra.length) {
      lines.push(`  ${m.extra.length} undeclared difference entries:`);
      lines.push(...formatGroups(groupBySite(m.extra), { maxGroups: 20 }));
    }
    for (const p of m.problems) lines.push(p.change ? `  entry ${p.change.index}${p.commit ? ` in ${p.commit.slice(0, 10)}` : ''}: ${p.problem}` : `  ${p.problem}`);
  }
  if (c.info.length) {
    const ig = groupBySite(c.info);
    lines.push(`Informational (default, x-*, keywords Ajv ignores; not part of the verdict): ${c.info.length} entries at ${ig.length} sites`);
    lines.push(...formatGroups(ig, { maxGroups: 15, maxRoots: 2 }));
  }
  if (report.corpus) {
    const k = report.corpus;
    lines.push(`Corpus: ${k.bound_checked}/${k.bound_total} bound instances checked, ${k.probe_values} probe values against ${k.sites_probed} changed sites (${k.ms} ms)`);
    for (const [src, n] of Object.entries(k.counts)) lines.push(`  ${src}: ${n.checked} checked, ${n.valid_both} valid at both, ${n.invalid_both} invalid at both, ${n.changed} changed, ${n.unpaired} unpaired`);
    if (k.changes.length) {
      lines.push(`  Verdict changes (${k.changes.length}):`);
      for (const ch of k.changes.slice(0, 30)) lines.push(`    ${ch.source} ${ch.label} [${ch.schema}]: base ${ch.base.v}${ch.base.error ? ` (${ch.base.error})` : ''} -> head ${ch.head.v}${ch.head.error ? ` (${ch.head.error})` : ''}`);
    } else lines.push('  Verdict changes: none');
    if (k.probe_hits.length) {
      lines.push(`  Unbound probe hits (heuristic, not evidence; values found under the same parent and property name): ${k.probe_hits.length} sites`);
      for (const h of k.probe_hits.slice(0, 20)) {
        lines.push(`    ${h.site} (under ${h.under.slice(0, 4).join(', ')}${h.under.length > 4 ? ', …' : ''}): ${h.hits} value${h.hits === 1 ? '' : 's'}, e.g. ${h.samples.slice(0, 2).map(s => `${short(s.value, 60)} (${s.base} -> ${s.head}, ${s.found_at})`).join('; ')}`);
      }
    }
  }
  if (report.witnesses) {
    const w = report.witnesses;
    lines.push(`Witnesses: ${w.filter(x => x.ok).length}/${w.length} manifest entries pass the witness check (an attributed witness per declared direction, none for "none")`);
    for (const x of w) {
      lines.push(`  entry ${x.index} (${x.direction}): ${x.ok ? 'ok' : 'MISSING'}`);
      for (const p of x.payloads || []) {
        lines.push(`    ${p.kind}: ${p.root} with ${p.at || '/'} = ${short(p.value, 100)} (base ${p.base}, head ${p.head}; full payload in the JSON report)`);
      }
      if (!x.ok && x.reason) lines.push(`    ${x.reason}`);
    }
  }
  if (report.corpus_skipped) lines.push(`Corpus: skipped (${report.corpus_skipped})`);
  if (report.timings) lines.push(`Time: ${Object.entries(report.timings).map(([k, v]) => `${k.replace(/_ms$/, '')} ${(v / 1000).toFixed(1)} s`).join(', ')}`);
  lines.push(`Result: ${report.ok ? 'PASS' : 'FAIL'}${report.failures.length ? ` (${report.failures.join('; ')})` : ''}`);
  return lines.join('\n');
}

module.exports = { formatText, groupBySite };
