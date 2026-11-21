// The staged-image check is advisory, as it always was in the hook: a finding
// is printed and recorded as a warning, and does not fail the commit.
import { test } from 'vitest';
import { runAdvisoryCheck } from './command';

test('bash scripts/check-image-quality.sh (advisory)', async ({ annotate }) => {
  await runAdvisoryCheck('bash scripts/check-image-quality.sh', annotate);
});
