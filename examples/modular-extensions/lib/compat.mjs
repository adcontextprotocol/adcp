// Which core releases can an extension run against?
//
// An extension manifest says what it needs; a core release (core/release.json)
// says what it provides. Compatibility is computed, never guessed:
//
//   "requires": {
//     "core":       ">=3.3 <5",                          // author's range (npm-style), a ceiling
//     "points":     { "commercial_terms": 1 },           // hooks it attaches at (extension points and unions), by contract major
//     "core_types": { "/schemas/core/duration.json": 1 } // core types it $refs, by major (filled in by the build)
//   }
//
// compatible(ext, core) <=> core.adcp_version satisfies requires.core
//                         and every hook it uses exists in some layer at that major
//                         and every core type it $refs exists in core at that major.
//
// So one extension digest serves every core release that keeps those contracts
// (3.3, 3.4, ... and even 4.0 if 4.0 did not touch them), and a core release
// that changes one of them is refused with the exact reason.

/** Compare two dotted versions ("3.3", "3.3.0", "4"). Missing parts are 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** One comparator: >=v  >v  <=v  <v  =v  ^v  v (exact). */
function comparatorHolds(version, comp) {
  const m = /^(>=|<=|>|<|=|\^)?\s*(\d+(?:\.\d+){0,2})$/.exec(comp.trim());
  if (!m) throw new Error(`bad version comparator: ${comp}`);
  const [, op = '=', v] = m;
  const c = compareVersions(version, v);
  switch (op) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '^': return c >= 0 && Number(String(version).split('.')[0]) === Number(v.split('.')[0]);
  }
}

/** npm-style range: comparators separated by spaces (AND), alternatives by `||` (OR). */
export function satisfies(version, range) {
  return range.split('||').some((alt) => alt.trim().split(/\s+/).filter(Boolean).every((c) => comparatorHolds(version, c)));
}

/** Highest version in `versions` that satisfies `range`. */
export function maxSatisfying(versions, range) {
  return versions.filter((v) => satisfies(v, range)).sort(compareVersions).pop() ?? null;
}

/** Hook -> contract major across all layers (a layered release), or the flat `points` map (simulated releases). */
export const hooksOf = (release) =>
  release.points ?? Object.assign({}, ...Object.values(release.layers ?? {}).map((l) => l.hooks ?? {}));

export const typeMajor = (release, id) =>
  release.types.removed?.includes(id) ? null : release.types.overrides?.[id] ?? release.types.default_major;

/**
 * @param manifest the extension manifest (bundle['x-adcp-extension'])
 * @param release  a core release manifest (core/release.json format)
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkCompat(manifest, release) {
  const reasons = [];
  const req = manifest.requires ?? {};
  if (req.core && !satisfies(release.adcp_version, req.core)) {
    reasons.push(`core ${release.adcp_version} is outside the extension's declared range ${req.core}`);
  }
  const hooks = hooksOf(release);
  for (const [point, major] of Object.entries(req.points ?? {})) {
    const have = hooks[point];
    if (have === undefined) reasons.push(`extension point ${point} does not exist in core ${release.adcp_version}`);
    else if (have !== major) reasons.push(`extension point ${point} is v${have} in core ${release.adcp_version}; extension needs v${major}`);
  }
  for (const [id, major] of Object.entries(req.core_types ?? {})) {
    const have = typeMajor(release, id);
    if (have === null) reasons.push(`core type ${id} was removed in core ${release.adcp_version}`);
    else if (have !== major) reasons.push(`core type ${id} is v${have} in core ${release.adcp_version}; extension was built against v${major}`);
  }
  return { ok: reasons.length === 0, reasons };
}
