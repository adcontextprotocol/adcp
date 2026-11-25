'use strict';

// The node:test files the pre-commit hook runs, migrated to vitest
// (tp-jyw.51): vitest.config.ts runs them in the precommit:node-tests
// project, with vitest's globals. tests/git-env-isolation.test.cjs runs them
// with vitest, and scripts/lint-test-builds.cjs scans them as the vitest
// files they now are. Every other tests/*.test.cjs file is a node:test file
// that only `npm test` runs.
const NODE_TEST_FILES = [
  // Canonical display vectors and the governance JWS vectors.
  'tests/canonical-image-pixel-ratio-vectors.test.cjs',
  'tests/canonical-display-acceptance-vectors.test.cjs',
  'tests/governance-authorization-jws-vectors.test.cjs',
  // Storyboard compliance (test:auction-only-compliance; node --import tsx
  // before, so tests/setup/tsx-require.cjs).
  'tests/auction-only-seller-compliance.test.cjs',
  'tests/creative-format-gate-compliance.test.cjs',
  'tests/currency-filter-compliance.test.cjs',
  'tests/optional-seller-capabilities.test.cjs',
  'tests/product-filter-auction-compliance.test.cjs',
  'tests/canonical-compatibility-slices.test.cjs',
  'tests/governance-recovery-pricing-scope.test.cjs',
  'tests/literal-auction-bid-compliance.test.cjs',
  'tests/optional-discovery-contract.test.cjs',
  'tests/storyboard-exclusion-compat.test.cjs',
  'tests/operator-fee-seller-exclusion.test.cjs',
  // Lint tests (test:test-dynamic-imports ... test:callapi-state-change).
  'tests/lint-test-dynamic-imports.test.cjs',
  'tests/lint-test-spawn-tooling.test.cjs',
  'tests/lint-test-builds.test.cjs',
  'tests/lint-test-git-env.test.cjs',
  'tests/lint-format-identity-boundaries.test.cjs',
  'tests/lint-narrow-imports.test.cjs',
  'tests/lint-module-eval-cycles.test.cjs',
  'tests/lint-callapi-state-change.test.cjs',
];

module.exports = { NODE_TEST_FILES };
