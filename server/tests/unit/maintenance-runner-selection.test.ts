import { describe, expect, it } from 'vitest';
import { isThreeZeroComplianceVersion, maintenanceRunner } from '../manual/maintenance-runner-selection.js';

describe('maintenance compliance runner boundaries', () => {
  it('uses the modern runner for every current seller scenario', () => {
    expect(maintenanceRunner('sales', undefined)).toBe('seller');
    expect(maintenanceRunner('sales', '3.1.30')).toBe('seller');
  });

  it('retains the existing runner for unrelated cohorts', () => {
    for (const cohort of ['signals', 'governance', 'creative', 'creative-builder', 'brand']) {
      expect(maintenanceRunner(cohort, undefined)).toBe('legacy');
    }
  });

  it('recognizes frozen 3.0 releases and retains their runner', () => {
    for (const version of ['3.0.13', '3.0.30']) {
      expect(isThreeZeroComplianceVersion(version)).toBe(true);
      expect(maintenanceRunner('sales', version)).toBe('legacy');
    }
    for (const version of [undefined, '3.1.30', '3.0', '3x0x30', '3.0.30-beta.1']) {
      expect(isThreeZeroComplianceVersion(version)).toBe(false);
    }
  });
});
