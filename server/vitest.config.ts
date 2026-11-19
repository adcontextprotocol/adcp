import { defineConfig } from 'vitest/config';
import { resolveWorkerCount, serverProjects, serverTestBase } from './vitest.projects.ts';

// The server suite (`npm run test:server-unit`, CI's shards). Its projects
// are defined in ./vitest.projects.ts, which the root vitest.config.ts also
// uses for the pre-commit hook's server step.
export default defineConfig({
  test: {
    ...serverTestBase(),
    maxWorkers: resolveWorkerCount({ reservedCpus: 1 }),
    projects: serverProjects().map((test) => ({ extends: true, test })),
  },
});
