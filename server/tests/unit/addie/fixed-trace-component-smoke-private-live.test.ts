import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY,
  fixedTraceComponentSmokePrivateAuthorityPlan,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-authority.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_DEFAULT_OFF,
  createFixedTraceComponentSmokePrivateLiveCoordinator,
  fixedTraceComponentSmokePrivateLivePreflight,
  fixedTraceComponentSmokePrivateLiveSlots,
  inspectFixedTraceComponentSmokePrivateLiveSlotJson,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-live.js';

const slots = fixedTraceComponentSmokePrivateLiveSlots();
const declaration = (slot = slots[0]) => JSON.stringify({
  slotKey: slot.slotKey,
  admissionFingerprint: slot.admissionFingerprint,
  assignmentId: slot.assignmentId,
  probeId: slot.probeId,
  cellId: slot.cellId,
  provider: slot.provider,
  model: slot.model,
  effort: slot.effort,
  invocationOrdinal: slot.invocationOrdinal,
});

describe('private live component-smoke preflight contract', () => {
  it('leaves production hard-null and default-off without an execution export', () => {
    expect(FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_DEFAULT_OFF).toBe(true);
    expect(createFixedTraceComponentSmokePrivateLiveCoordinator()).toBeNull();
    expect((createFixedTraceComponentSmokePrivateLiveCoordinator as (...args: unknown[]) => unknown)({}, {}, {})).toBeNull();
  });

  it('derives exactly 192 unique provider accounting slots from the immutable 168-assignment authority', () => {
    const plan = fixedTraceComponentSmokePrivateAuthorityPlan();
    expect(plan).toHaveLength(168);
    expect(slots).toHaveLength(192);
    expect(new Set(slots.map((slot) => slot.slotKey))).toHaveLength(192);
    expect(new Set(slots.map((slot) => slot.assignmentId))).toHaveLength(126);
    expect(slots.every((slot) => slot.admissionFingerprint === FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint)).toBe(true);
    expect(Object.isFrozen(slots)).toBe(true);
    expect(slots.every(Object.isFrozen)).toBe(true);
  });

  it('binds every declarative fixture key to fingerprint, assignment, probe, cell, provider, model, effort, and ordinal', () => {
    for (const slot of slots) {
      const inspected = inspectFixedTraceComponentSmokePrivateLiveSlotJson(declaration(slot));
      expect(inspected).toMatchObject({ status: 'not_provisioned', slot });
      expect(inspected.slot?.slotKey).toBe(slot.slotKey);
    }
  });

  it('refuses a declaration if any exact slot dimension is changed', () => {
    const slot = slots.find((candidate) => candidate.invocationOrdinal === 2)!;
    const dimensions = ['admissionFingerprint', 'assignmentId', 'probeId', 'cellId', 'provider', 'model', 'effort', 'invocationOrdinal'] as const;
    for (const dimension of dimensions) {
      const parsed = JSON.parse(declaration(slot)) as Record<string, unknown>;
      parsed[dimension] = dimension === 'invocationOrdinal' ? 1 : `wrong-${dimension}`;
      expect(inspectFixedTraceComponentSmokePrivateLiveSlotJson(JSON.stringify(parsed))).toEqual({
        status: 'refused', reason: 'unknown_or_mismatched_slot_declaration', slot: null,
      });
    }
  });

  it('refuses object inputs before access and only accepts exact JSON-text declarations', () => {
    const getter = Object.defineProperty({}, 'toString', { get: () => { throw new Error('getter executed'); } });
    expect(inspectFixedTraceComponentSmokePrivateLiveSlotJson(getter)).toEqual({
      status: 'refused', reason: 'invalid_json_declaration', slot: null,
    });
    expect(inspectFixedTraceComponentSmokePrivateLiveSlotJson('{"assignmentId":"only"}')).toEqual({
      status: 'refused', reason: 'invalid_json_declaration', slot: null,
    });
    expect(inspectFixedTraceComponentSmokePrivateLiveSlotJson('{not json')).toEqual({
      status: 'refused', reason: 'invalid_json_declaration', slot: null,
    });
  });

  it('makes first-call replay and second-call continuation gaps explicit instead of fabricating requests', () => {
    const first = slots.find((slot) => slot.invocationOrdinal === 1)!;
    const continuation = slots.find((slot) => slot.invocationOrdinal === 2)!;
    expect(inspectFixedTraceComponentSmokePrivateLiveSlotJson(declaration(first))).toMatchObject({
      status: 'not_provisioned', reason: 'exact_request_tool_replay_binding_unprovisioned',
      slot: { semanticRequestFingerprint: null, providerContinuationBinding: 'not_applicable' },
    });
    expect(inspectFixedTraceComponentSmokePrivateLiveSlotJson(declaration(continuation))).toMatchObject({
      status: 'not_provisioned', reason: 'exact_provider_continuation_binding_unprovisioned',
      slot: { semanticRequestFingerprint: null, providerContinuationBinding: 'unprovisioned_exact_provider_continuation_binding' },
    });
  });

  it('never treats the admission pin or its policy version as a replay binding', () => {
    expect(fixedTraceComponentSmokePrivateLivePreflight()).toEqual({
      status: 'not_provisioned', reason: 'exact_request_tool_replay_binding_unprovisioned', slot: null,
    });
  });

  it('has no provider, credential, persistence, adapter, callback, or raw request/response surface', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-live.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'process.env', 'fetch(', 'console.', 'new OpenAI', 'new Anthropic', 'new GoogleGenAI', 'apiKey', 'trustRoot', 'privateKey',
      'PostgresFixedTraceComponentSmokePrivateLedger', 'recordProviderIntent', 'recordUnknownExposure', 'structuredClone', 'ModelRequest',
      'ForTest', 'requestFor', 'responseHmac', 'preparedRequestHmac', 'invoke(', 'transport',
    ]) expect(source).not.toContain(forbidden);
    expect(source).not.toContain("from '../config/models");
    expect(source).toContain('JSON.parse(jsonText)');
  });
});
