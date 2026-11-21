'use strict';

// The precommit:node-tests project's setup file (vitest.config.ts): what
// `node --import tsx --test` gave these files. Their own `require()` is
// Node's, so a require of a server TypeScript module needs tsx's CommonJS
// hook in the worker.
require('tsx/cjs/api').register();
