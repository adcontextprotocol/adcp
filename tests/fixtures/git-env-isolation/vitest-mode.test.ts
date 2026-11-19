// Guard fixture for the vitest branch of tests/git-env-isolation.test.cjs.
// It passes, except when tests/git-env-isolation-guard.test.cjs sets
// ISOLATION_FIXTURE_MODE=fail to check that the guard reports a
// failing vitest file. test:unit runs it with the mode unset, so it passes.
import { expect, it } from 'vitest';

it('fails only when the guard meta-test asks it to', () => {
  if (process.env.ISOLATION_FIXTURE_MODE === 'fail') {
    expect.fail('deliberate failure in the guard fixture');
  }
});
