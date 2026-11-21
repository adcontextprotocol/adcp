// Vitest setup file. On macOS under Conductor, Supertest can address the
// wrong loopback family; tests/setup/conductor-supertest-loopback.ts explains
// and fixes it. Loaded only when needed, so ordinary runs never import
// Supertest. Kept apart from revenue-tracking-env.ts, which imports `vitest`
// and therefore cannot load outside a vitest run, so this file's load
// behavior stays checkable in a plain Node process
// (tests/unit/deferred-imports.test.ts).
if (process.env.CONDUCTOR_IS_LOCAL === '1') {
  const { installConductorSupertestLoopback } = await import('./conductor-supertest-loopback.js');
  installConductorSupertestLoopback();
}

export {};
