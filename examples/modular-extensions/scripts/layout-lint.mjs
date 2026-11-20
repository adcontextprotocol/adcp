#!/usr/bin/env node
// The final layout's checks on the vendored subset. Blocking: any violation fails the build and the tests.
//
//   node scripts/layout-lint.mjs
//
// The checks (lib/layout.mjs classifyRef): a module $refs no other module (star), the kernel layer $refs
// no module, a buying layer $refs only the kernel layer and the layers below it, siblings (pricing and
// catalogs, offer and execution) don't $ref each other, a module $refs an extension's file only under a
// bridge point that extension fills, and an extension $refs only the modules it connects. An assembly
// (the generated `_assembly`, and the 3.x compatibility assembly `_compat`) composes modules by definition,
// so the checks skip it. They cover only the files this example vendors, not the whole tree.
//
// Upstream breaks some of these rules today. core/patches.json applies the layout's 3.4 fixes, each of which
// keeps the wire bytes: kernel types with registry composition (op compose), and bridge points
// (x-adcp-bridge-point). The two $refs that leave only with the removals 4.0 already slates sit in the
// 3.x compatibility assembly (scripts/vendor-core.mjs COMPAT_ASSEMBLY). So the target is zero, with no baseline.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoreSchemas } from '../lib/core-schemas.mjs';
import { layoutViolations, refOccurrences, violationKey } from '../lib/layout.mjs';
import { placement } from './build-core.mjs';

/** { violations, bridged, composed }: violations must be empty. */
export function lint(schemas = loadCoreSchemas(), owner = placement()) {
  const refs = refOccurrences(schemas);
  let composed = 0;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n['x-adcp-registry'] || n['x-adcp-composed-from']) composed++;
    Object.values(n).forEach(walk);
  };
  for (const { schema } of schemas) walk(schema);
  return { violations: layoutViolations(schemas, owner), bridged: refs.filter((r) => r.point).length, composed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = lint();
  console.log(
    `layout check (vendored subset): ${r.violations.length} violations; ${r.bridged} $refs under bridge points, ${r.composed} composed registry fields`
  );
  for (const v of r.violations) console.error(`VIOLATION ${v.check}: ${v.from} -> ${v.to}: ${violationKey(v)}`);
  if (r.violations.length) process.exit(1);
}

