import { writeFileSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

// Writes the run's test files, as tests/setup/built-schemas.ts reads them, to
// GLOBAL_SETUP_PATHS_OUT.
export default function setup(project: TestProject): void {
  writeFileSync(process.env.GLOBAL_SETUP_PATHS_OUT!, JSON.stringify(project.vitest.state.getPaths()));
}
