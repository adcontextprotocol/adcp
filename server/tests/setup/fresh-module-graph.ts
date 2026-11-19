// Runs before every file of the `unit-fresh` project (server/vitest.config.ts):
// files that mock modules or prepare state before their imports.
//
// That project reuses worker processes across files, and a worker keeps
// every module it has evaluated. `vi.mock` replaces a module only for code
// imported after the mock registers, and a module that reads env at import
// reads it once, so a cached module would keep whatever an earlier file gave
// it: that file's mock factories and env, or the real module this file
// mocks. Clearing the module registry before the file's imports
// gives each file a server/src module graph built with its own mocks; vitest
// documents this for modules cached before a test file runs ("You can call
// vi.resetModules() inside vi.hoisted to clear all module caches before
// running a test file", https://vitest.dev/api/vi#vi-mock). Dependencies
// Node loads natively (node_modules such as @adcp/sdk, zod, ajv) stay loaded,
// so their caches survive from file to file.
//
// The previous file's graph armed a flush interval in every rate-limit store
// its route modules built; stop them first, or each reset leaves another set
// of live intervals, each keeping that graph reachable. The store registry
// keeps its state on `globalThis`, so this import reaches every graph's stores.
import { vi } from 'vitest';
import { shutdownAll } from '../../src/middleware/rate-limit-store-registry.js';

await shutdownAll();
vi.resetModules();
