/** Keep unrelated maintenance cohorts on their existing production runner. */
export function isThreeZeroComplianceVersion(version: string | undefined): boolean {
  return version !== undefined && /^3\.0\.\d+$/.test(version);
}

export function maintenanceRunner(cohort: string | undefined, version: string | undefined): 'seller' | 'legacy' {
  return cohort === 'sales' && !isThreeZeroComplianceVersion(version) ? 'seller' : 'legacy';
}
