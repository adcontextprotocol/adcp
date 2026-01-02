/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'server/src/billing/**/*.ts',
    'server/src/db/organization-db.ts',
    '!server/src/**/*.d.ts',
    '!server/src/**/*.test.ts',
  ],
  // Ignore the existing test files that aren't Jest tests
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/schema-validation.test.cjs',
    '/tests/example-validation-simple.test.cjs',
    '/tests/extension-fields.test.cjs',
    '/tests/snippet-validation.test.cjs',
  ],
};
