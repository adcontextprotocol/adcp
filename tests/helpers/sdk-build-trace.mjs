/**
 * Records which @adcp/sdk build each module resolution reaches.
 *
 * Load it before any other loader so it sees every edge:
 *
 *   ADCP_SDK_BUILD_TRACE_FILE=<file.jsonl> node --import ./tests/helpers/sdk-build-trace.mjs --import tsx ...
 *
 * A synchronous `node:module` resolve hook sees `import`, `import()`,
 * `require()` and `createRequire(...)(...)` / `.resolve(...)` alike. Every
 * resolution whose target is inside node_modules/@adcp/sdk/dist/lib/ is
 * appended to the JSONL file as one line:
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

const SDK_LIB = '/node_modules/@adcp/sdk/dist/lib/';

function buildOf(url) {
  if (url.endsWith('.mjs')) return 'esm';
  if (url.endsWith('.js') || url.endsWith('.cjs')) return 'cjs';
  return 'other';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (typeof result.url === 'string' && result.url.includes(SDK_LIB)) {
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
