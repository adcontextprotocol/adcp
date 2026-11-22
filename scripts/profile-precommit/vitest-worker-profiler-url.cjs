// The --import URL that loads vitest-worker-profiler.mjs into vitest's fork
// workers. The profile directories travel in one query parameter, `dirs`, as
// base64url JSON, so the URL holds no character a shell or npm treats
// specially (both callers pass it through a shell). Used by
// scripts/profile-precommit.mjs and scripts/precommit-server-unit.cjs.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.join(__dirname, 'vitest-worker-profiler.mjs');

/** The module URL for these directories, or '' when neither is set. */
function vitestWorkerProfilerUrl({ cpu, heap } = {}) {
  if (!cpu && !heap) return '';
  const dirs = { ...(cpu ? { cpu: path.resolve(cpu) } : {}), ...(heap ? { heap: path.resolve(heap) } : {}) };
  const url = pathToFileURL(MODULE);
  url.search = `dirs=${Buffer.from(JSON.stringify(dirs)).toString('base64url')}`;
  return url.href;
}

module.exports = { vitestWorkerProfilerUrl };
