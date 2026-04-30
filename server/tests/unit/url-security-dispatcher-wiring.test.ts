/**
 * Pins the SSRF-safe dispatcher's construction shape.
 *
 * The integration test at `tests/integration/url-security-safefetch.test.ts`
 * proves that `safeFetch('https://example.com')` works end-to-end, but it
 * cannot prove that `Agent({ connect: { lookup } })` is what made it work —
 * the same fetch would pass with no dispatcher at all (Node's default fetch
 * resolves DNS and connects on its own).
 *
 * If a future refactor drops the dispatcher (or undici renames `connect.lookup`),
 * the integration test stays green and DNS-rebind silently reopens. This unit
 * test catches that by intercepting the `Agent` constructor and asserting the
 * `lookup` option was passed through.
 *
 * Tracked from the testing-expert review on PR #3609 (issue #3599).
 */
import { describe, it, expect, vi } from 'vitest';

const agentSpy = vi.hoisted(() =>
  vi.fn(function FakeAgent(this: { __opts: unknown }, opts: unknown) {
    this.__opts = opts;
  }),
);

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, Agent: agentSpy };
});

import { buildSsrfSafeDispatcher, ssrfSafeLookup } from '../../src/utils/url-security.js';

describe('buildSsrfSafeDispatcher', () => {
  it('constructs an undici Agent with ssrfSafeLookup as the connect.lookup', () => {
    agentSpy.mockClear();
    buildSsrfSafeDispatcher();
    expect(agentSpy).toHaveBeenCalledOnce();

    const opts = agentSpy.mock.calls[0][0] as {
      connect?: { lookup?: typeof ssrfSafeLookup };
    };
    expect(opts.connect).toBeDefined();
    // Identity check — the dispatcher must wire OUR lookup, not Node's default.
    // If someone refactors the option name (e.g. `connect.dns.lookup`), this
    // assertion fails before the SSRF gap can ship.
    expect(opts.connect!.lookup).toBe(ssrfSafeLookup);
  });
});
