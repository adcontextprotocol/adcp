// The committed governance JWS vectors are what the generator writes
// (package.json `test:governance-jws-vectors`, its first clause:
// `node scripts/generate-governance-jws-vectors.mjs --check`), in process.
import { expect, test } from 'vitest';
import { checkGovernanceJwsVectors } from '../../scripts/generate-governance-jws-vectors.mjs';

test('node scripts/generate-governance-jws-vectors.mjs --check', () => {
  expect(checkGovernanceJwsVectors()).toBeNull();
});
