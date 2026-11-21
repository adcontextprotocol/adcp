/**
 * Records which @adcp/sdk build each module resolution reaches.
 *
 * Load it before any other loader so it sees every edge:
 *
 *   ADCP_SDK_BUILD_TRACE_FILE=<file.jsonl> node --import ./tests/helpers/sdk-build-trace.mjs --import tsx ...
 *
 * A synchronous `node:module` resolve hook sees `import`, `import()`,
 * `require()` and `createRequire(...)(...)` / `.resolve(...)` alike. Every
 * resolution whose target is inside node_modules/@adcp/sdk/ (outside its own
 * node_modules) is appended to the JSONL file as one line:
 *
 *   { pid, parentURL, specifier, url, build: 'esm' | 'cjs' | 'other', conditions }
 *
 * `build` is 'esm' for .mjs targets and 'cjs' for .js/.cjs targets. Lines are
 * appended per edge rather than at exit, because storyboard children may end
 * with SIGKILL and never run exit handlers.
 */

import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const out = process.env.ADCP_SDK_BUILD_TRACE_FILE;
if (!out) {
  throw new Error('sdk-build-trace.mjs needs ADCP_SDK_BUILD_TRACE_FILE (the JSONL file to append edges to)');
}

// The package root, not its build directory: the build is told apart by file
// extension below, and the SDK's own dependencies are left out.
const SDK_PACKAGE = '/node_modules/@adcp/sdk/';
const SDK_DEPENDENCIES = '/node_modules/@adcp/sdk/node_modules/';

function buildOf(url) {
  if (url.endsWith('.mjs')) return 'esm';
  if (url.endsWith('.js') || url.endsWith('.cjs')) return 'cjs';
  return 'other';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (typeof result.url === 'string' && result.url.includes(SDK_PACKAGE) && !result.url.includes(SDK_DEPENDENCIES)) {
      appendFileSync(out, `${JSON.stringify({
        pid: process.pid,
        parentURL: context.parentURL ?? null,
        specifier,
        url: result.url,
        build: buildOf(result.url),
        conditions: context.conditions ?? [],
      })}\n`);
    }
    return result;
  },
});
