// Packages that are costly to evaluate and that most importers use on only a
// few code paths. Loading them here, on first use, keeps every module that
// imports a caller (and every unit test file that imports one) from paying
// for them at import time: isomorphic-dompurify builds a jsdom window when it
// loads (~0.5 s), linkedom ~0.1 s.
//
// Production loads all of them at boot anyway: server/src/index.ts awaits
// preloadDeferredModules() before it starts the server, so boot-time failure,
// memory and first-request latency stay as they were with static imports.
//
// The getters are the only access path for these packages in server/src.
// Under tsx (npm start, tsx child processes) a synchronous require of an ES
// module and an `import()` of it can produce two separate instances, so mixing
// the two would give callers different DOMPurify singletons. For the same
// reason a `vi.mock('isomorphic-dompurify')` does not intercept the getter.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type IsomorphicDOMPurify = typeof import('isomorphic-dompurify');
type Linkedom = typeof import('linkedom');

const requireHere = createRequire(import.meta.url);

/**
 * Load a package's ES module build synchronously (Node's `require(esm)`).
 * Resolving with `import.meta.resolve` selects the `import` export condition,
 * so this evaluates the same file a static `import` would, not the package's
 * CommonJS build.
 */
function loadEsmSync<T>(specifier: string): T {
  return requireHere(fileURLToPath(import.meta.resolve(specifier))) as T;
}

let domPurify: IsomorphicDOMPurify['default'] | undefined;
let linkedom: Linkedom | undefined;

/** The isomorphic-dompurify singleton, loaded on first call. */
export function getDOMPurify(): IsomorphicDOMPurify['default'] {
  domPurify ??= loadEsmSync<IsomorphicDOMPurify>('isomorphic-dompurify').default;
  return domPurify;
}

/** The linkedom module, loaded on first call. */
export function getLinkedom(): Linkedom {
  linkedom ??= loadEsmSync<Linkedom>('linkedom');
  return linkedom;
}

/**
 * Load every deferred package now. The server entrypoint calls this before it
 * starts, so a missing or broken package still fails the boot.
 */
export async function preloadDeferredModules(): Promise<void> {
  getDOMPurify();
  getLinkedom();
  await Promise.all([import('pdf-parse'), import('mammoth'), import('@google-cloud/kms')]);
}
