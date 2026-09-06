import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES,
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PACK_DIGEST,
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
  assertFixedTraceArchitectureDiagnosticPack,
  assertFixedTraceArchitectureDiagnosticSuite,
  fixedTraceArchitectureDiagnosticPlan,
} from '../../../src/addie/eval/fixed-trace-architecture-diagnostic.js';
import { decideFixedTraceHybridRoute, fixedTraceHybridPolicy } from '../../../src/addie/eval/fixed-trace-architecture.js';

describe('fixed-trace architecture diagnostic pack', () => {
  it('pins the 24 synthetic development cases, their semantic hashes, and their matched strata', () => {
    assertFixedTraceArchitectureDiagnosticPack();
    expect(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES).toHaveLength(24);
    expect(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PACK_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES.filter((entry) => entry.stratum === 'local_terminal_eligible')).toHaveLength(8);
    expect(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES.filter((entry) => entry.stratum === 'matched_hybrid_fallback_near_miss')).toHaveLength(8);
    expect(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES.filter((entry) => entry.stratum === 'routed_tool_or_safety')).toHaveLength(8);
    const pairs = FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES.filter((entry) => entry.localNearPairId !== null)
      .reduce((counts, entry) => counts.set(entry.localNearPairId!, (counts.get(entry.localNearPairId!) ?? 0) + 1), new Map<string, number>());
    expect([...pairs.values()]).toEqual(Array(8).fill(2));
    expect(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES.every((entry) => entry.trace.privacy === 'synthetic')).toBe(true);
  });

  it('routes only the reviewed exact harmless local forms locally and sends every near miss to the incumbent router', () => {
    for (const entry of FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_CASES) {
      const decision = decideFixedTraceHybridRoute({
        message: entry.trace.request.message,
        source: entry.trace.request.source,
        isAdmin: entry.trace.request.isAdmin,
        isThread: (entry.trace.request.threadContext?.length ?? 0) > 0,
        channelPrivacy: entry.trace.request.channelPrivacy,
        policy: fixedTraceHybridPolicy(),
      });
      if (entry.stratum === 'local_terminal_eligible') expect(decision.mode).toBe('local_terminal');
      else expect(decision.mode).toBe('llm_router_fallback');
    }
  });

  it('refuses mutation, reordering, and proxy laundering of the exact suite', () => {
    const mutated = structuredClone(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE);
    mutated[0]!.request.message = 'delete synthetic receipt';
    expect(() => assertFixedTraceArchitectureDiagnosticSuite(mutated)).toThrow('differs from the predeclared synthetic pack');
    expect(() => assertFixedTraceArchitectureDiagnosticSuite([...FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE].reverse()))
      .toThrow('differs from the predeclared synthetic pack');
    expect(() => assertFixedTraceArchitectureDiagnosticSuite(new Proxy(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE, {})))
      .toThrow('Proxy');
  });

  it('emits exact, no-call ceilings only for the two reviewed Sonnet-finalist configurations', () => {
    const haiku = fixedTraceArchitectureDiagnosticPlan('haiku');
    const luna = fixedTraceArchitectureDiagnosticPlan('luna');
    expect(haiku).toMatchObject({
      diagnosticOnly: true, dispatchable: false, productionEligible: false, canaryEligible: false,
      router: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'provider_default' },
      generation: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'provider_default' },
      ceilings: {
        directGenerationCalls: 288, routedRouterCalls: 24, routedGenerationCalls: 288,
        hybridLocalTerminalCases: 8, hybridRouterCalls: 16, hybridGenerationCalls: 192,
        totalRouterCalls: 40, totalGenerationCalls: 768, totalCalls: 808, totalUsd: 32.301664,
      },
    });
    expect(luna).toMatchObject({
      router: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
      ceilings: { totalCalls: 808, totalUsd: 32.124992 },
    });
    expect(fixedTraceArchitectureDiagnosticPlan('haiku', 3).ceilings.totalCalls).toBe(2424);
    expect(fixedTraceArchitectureDiagnosticPlan('haiku', 3).ceilings.totalUsd).toBeCloseTo(96.904992, 12);
  });
});
