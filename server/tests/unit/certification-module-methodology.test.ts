import { describe, expect, it, vi } from 'vitest';

// certification-tools.ts imports the certification-db module; stub it so this
// pure-function test never touches a real database.
vi.mock('../../src/db/certification-db.js', () => ({}));

import { selectModuleMethodology } from '../../src/addie/mcp/certification-tools.js';

// Distinctive markers from each methodology block.
const TEACHING_MARKER = 'Teaching approach';
const BUILD_PROJECT_MARKER = 'Build project approach';
const ARTIFACT_SUPPLEMENT_MARKER = 'artifact production is mandatory';

describe('selectModuleMethodology', () => {
  it('L3 gets the teaching methodology PLUS the decision-artifact capstone supplement', () => {
    const prompt = selectModuleMethodology('L3');
    // The capstone wiring: L3 is taught like an interactive module but supplemented
    // with the mandatory-artifact instruction. This is the regression guard.
    expect(prompt).toContain(TEACHING_MARKER);
    expect(prompt).toContain(ARTIFACT_SUPPLEMENT_MARKER);
    expect(prompt).toContain('necessary but not sufficient');
    // L3 is not a build-project capstone.
    expect(prompt).not.toContain(BUILD_PROJECT_MARKER);
  });

  it.each(['B4', 'C4', 'D4'])(
    'build-project module %s gets the build-project methodology, not the artifact supplement',
    (id) => {
      const prompt = selectModuleMethodology(id);
      expect(prompt).toContain(BUILD_PROJECT_MARKER);
      expect(prompt).not.toContain(ARTIFACT_SUPPLEMENT_MARKER);
    },
  );

  it.each(['L1', 'L2', 'A1', 'A2', 'B1', 'S1'])(
    'standard module %s gets the plain teaching methodology — no capstone supplement',
    (id) => {
      const prompt = selectModuleMethodology(id);
      expect(prompt).toContain(TEACHING_MARKER);
      expect(prompt).not.toContain(ARTIFACT_SUPPLEMENT_MARKER);
      expect(prompt).not.toContain(BUILD_PROJECT_MARKER);
    },
  );
});
