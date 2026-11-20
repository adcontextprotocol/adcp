// The additive check for a module minor: compare each schema a layer owns before and after the release,
// and accept only changes that every message valid under the previous minor still satisfies, and that a
// reader on the previous minor can receive.
//
//   additive       a new optional property (not in `required`); a new entry under definitions or $defs;
//                  a change to an annotation (description, title, examples, $comment, deprecated)
//   not additive   anything else: a removed or renamed property, a newly required one, a changed type,
//                  bound, pattern, const, or enum, a closed object, a new validation keyword on an
//                  existing node, or a changed hook annotation (x-adcp-*)
//
// A new optional property on a closed object (additionalProperties: false) is additive for writers, but a
// reader on the previous minor rejects it, so a sender omits it for that reader: the check reports it as
// additive with that note. The modules map in capabilities tells the sender which minor the reader has.

const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment', 'deprecated', 'default']);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @returns {{ additive: boolean, changes: { pointer: string, change: string, additive: boolean, note?: string }[] }}
 */
export function additiveDiff(before, after, pointer = '') {
  const changes = [];
  const walk = (a, b, at) => {
    if (same(a, b)) return;
    if (!isObj(a) || !isObj(b)) return changes.push({ pointer: at, change: `changed from ${JSON.stringify(a)} to ${JSON.stringify(b)}`, additive: false });
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const here = `${at}/${esc(key)}`;
      if (same(a[key], b[key])) continue;
      if (ANNOTATIONS.has(key)) {
        changes.push({ pointer: here, change: 'annotation changed', additive: true });
      } else if (key === 'properties' || key === 'definitions' || key === '$defs') {
        const pa = a[key] ?? {};
        const pb = b[key] ?? {};
        for (const name of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
          const p = `${here}/${esc(name)}`;
          if (!(name in pb)) changes.push({ pointer: p, change: `${key === 'properties' ? 'property' : 'definition'} ${name} removed`, additive: false });
          else if (!(name in pa)) {
            if (key !== 'properties') changes.push({ pointer: p, change: `definition ${name} added`, additive: true });
            else if ((b.required ?? []).includes(name)) changes.push({ pointer: p, change: `property ${name} added as required`, additive: false });
            else {
              const closed = b.additionalProperties === false;
              changes.push({
                pointer: p,
                change: `optional property ${name} added`,
                additive: true,
                ...(closed ? { note: 'the object is closed: a sender omits it for a reader on the previous minor' } : {}),
              });
            }
          } else walk(pa[name], pb[name], p);
        }
      } else if (key === 'required') {
        const ra = new Set(a.required ?? []);
        for (const r of b.required ?? []) if (!ra.has(r)) changes.push({ pointer: here, change: `${r} became required`, additive: false });
        for (const r of ra) if (!(b.required ?? []).includes(r)) changes.push({ pointer: here, change: `${r} is no longer required`, additive: false, note: 'a reader on the previous minor still requires it' });
      } else if (!(key in a)) {
        changes.push({ pointer: here, change: `keyword ${key} added to an existing schema`, additive: false });
      } else if (!(key in b)) {
        changes.push({ pointer: here, change: `keyword ${key} removed`, additive: false });
      } else if (isObj(a[key]) && isObj(b[key])) {
        walk(a[key], b[key], here);
      } else if (Array.isArray(a[key]) && Array.isArray(b[key]) && ['allOf', 'anyOf', 'oneOf'].includes(key) && a[key].length === b[key].length) {
        a[key].forEach((s, i) => walk(s, b[key][i], `${here}/${i}`));
      } else {
        changes.push({ pointer: here, change: `${key} changed from ${JSON.stringify(a[key])} to ${JSON.stringify(b[key])}`, additive: false });
      }
    }
  };
  walk(before, after, pointer);
  return { additive: changes.every((c) => c.additive), changes };
}

/**
 * The additive check over one layer: every file it owns, before and after.
 * @param before Map(file -> schema) for the layer's files at the previous minor
 * @param after  Map(file -> schema) at the new minor
 */
export function additiveLayerDiff(before, after) {
  const changes = [];
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!after.has(file)) changes.push({ file, pointer: '', change: 'file removed', additive: false });
    else if (!before.has(file)) changes.push({ file, pointer: '', change: 'file added', additive: true });
    else for (const c of additiveDiff(before.get(file), after.get(file)).changes) changes.push({ file, ...c });
  }
  return { additive: changes.every((c) => c.additive), changes };
}
