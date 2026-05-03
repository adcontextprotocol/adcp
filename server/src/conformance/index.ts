/**
 * Public surface of the conformance Socket Mode channel.
 *
 * Single import site for `http.ts` wiring and any future Addie
 * tools. Internals (transport, session store, token helpers) are
 * exported individually for tests but consumers should prefer
 * the named entry points.
 */

export { attachConformanceWS } from './ws-route.js';
export { buildConformanceTokenRouter } from './token-route.js';
export {
  conformanceSessions,
  type ConformanceSession,
} from './session-store.js';
export {
  issueConformanceToken,
  verifyConformanceToken,
  type ConformanceTokenClaims,
  type IssuedConformanceToken,
} from './token.js';
export { ConformanceWSServerTransport } from './ws-server-transport.js';
