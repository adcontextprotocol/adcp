import type { Rational } from './rational.js';

/** Machine-readable evidence returned with every diagnostic calculation. */
export interface ExactInferenceCertificate {
  readonly method: 'lloyd_moldovan_2008_restricted_score_e_plus_m';
  readonly nullBoundary: 'theta=-margin';
  readonly maximization: 'rational_sturm_and_interval_bisection';
  readonly evaluatedEndpoints: true;
  readonly stationaryPointCount: number;
  readonly pValue: Readonly<{ lower: Rational; upper: Rational }>;
  readonly safeCeiling: Readonly<{ maxN: number; maxPolynomialDegree: number; maxRootBisections: number }>;
  readonly exactness: 'certified_enclosure_only';
}

export interface IndeterminateCertificate {
  readonly method: 'lloyd_moldovan_2008_restricted_score_e_plus_m';
  readonly reason: 'ambiguous_score_ordering' | 'ambiguous_e_ordering' | 'root_isolation_ceiling' | 'complexity_ceiling';
  readonly reject: false;
}
