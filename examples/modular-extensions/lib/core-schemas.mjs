// Loads the buyer's pinned core bundle (core/schemas/).
//
// Core $ids are host-relative (/schemas/core/duration.json). An extension
// bundle has its own absolute $id, so a relative ref from it would resolve
// against the extension host. Rule used here: an extension refers to core as
// CORE_ORIGIN + core $id, and the buyer resolves that from its local pinned
// bundle. It is never fetched.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_ORIGIN = 'https://adcontextprotocol.org';
export const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/schemas');

export const coreIdFromUri = (uri) => uri.slice(CORE_ORIGIN.length).split('#')[0];
export const coreUri = (id) => CORE_ORIGIN + id;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.json')) yield p;
  }
}

/** [{ id: '/schemas/core/duration.json', file, schema }] */
export function loadCoreSchemas(dir = CORE_DIR) {
  return [...walk(dir)].sort().map((file) => {
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    return { id: schema.$id, file, schema };
  });
}
