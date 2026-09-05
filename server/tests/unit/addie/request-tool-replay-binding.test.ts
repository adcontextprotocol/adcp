import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS,
  captureSealedRequestToolReplayBinding,
  claimSealedRequestToolReplayBinding,
  type AddieRequestToolReplayFacts,
  type CaptureSealedRequestToolReplayBindingInput,
  type SealedRequestToolReplayBinding,
} from '../../../src/addie/request-tool-replay-binding.js';
import type { AddieRequestTools } from '../../../src/addie/request-tool-assembly.js';
import type { ToolHandler } from '../../../src/addie/model-providers/tool-orchestration.js';
import type { AddieTool } from '../../../src/addie/types.js';

function tool(name: string, description = name): AddieTool {
  return { name, description, input_schema: { type: 'object', properties: {} } };
}

function facts(overrides: Partial<AddieRequestToolReplayFacts> = {}): AddieRequestToolReplayFacts {
  return {
    caseId: 'case-a', surface: 'slack', isAAOAdmin: false, isThread: true,
    privacy: 'private', source: 'channel_message', requestTimeMs: Date.now(),
    replayPrincipal: 'U_TEST', ...overrides,
  };
}

function setup() {
  const globalAlpha = vi.fn(async () => 'global alpha') as ToolHandler;
  const globalBeta = vi.fn(async () => 'global beta') as ToolHandler;
  const localBeta = vi.fn(async () => 'local beta') as ToolHandler;
  const localGamma = vi.fn(async () => 'local gamma') as ToolHandler;
  const globalTools = [
    {
      ...tool('alpha'),
      usage_hints: 'initial alpha hint',
      replaySafety: 'pure_local' as const,
      input_schema: {
        type: 'object' as const,
        properties: { nested: { items: [{ safe: true }] } },
        required: ['nested'],
        additionalProperties: false,
      },
    },
    tool('beta', 'global beta'),
    tool('orphan'),
  ];
  const globalHandlers = new Map<string, ToolHandler>([
    ['alpha', globalAlpha], ['beta', globalBeta], ['unrelated', vi.fn(async () => 'unused')],
  ]);
  const requestTools: AddieRequestTools = {
    tools: [tool('beta', 'request beta'), tool('gamma')],
    handlers: new Map([['beta', localBeta], ['gamma', localGamma]]),
  };
  return {
    facts: facts(), globalTools, globalHandlers, requestTools,
    definitionOptions: undefined as CaptureSealedRequestToolReplayBindingInput['definitionOptions'],
    handlerAllowedToolNames: undefined as CaptureSealedRequestToolReplayBindingInput['handlerAllowedToolNames'],
    globalAlpha, globalBeta, localBeta, localGamma,
  };
}

function captureInput(value: ReturnType<typeof setup>): CaptureSealedRequestToolReplayBindingInput {
  return {
    facts: value.facts,
    globalTools: value.globalTools,
    globalHandlers: value.globalHandlers,
    requestTools: value.requestTools,
    definitionOptions: value.definitionOptions,
    handlerAllowedToolNames: value.handlerAllowedToolNames,
  };
}

function capture() {
  const value = setup();
  return { ...value, binding: captureSealedRequestToolReplayBinding(captureInput(value)) };
}

function trapProxy<T extends object>(target: T, calls: { count: number }): T {
  return new Proxy(target, {
    get: () => { calls.count++; throw new Error('proxy trap must not run'); },
    getOwnPropertyDescriptor: () => { calls.count++; throw new Error('proxy trap must not run'); },
    getPrototypeOf: () => { calls.count++; throw new Error('proxy trap must not run'); },
    ownKeys: () => { calls.count++; throw new Error('proxy trap must not run'); },
  });
}

describe('sealed request-local replay binding', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses #7299 assembly and projects only ordered handler-free intersection descriptors', () => {
    const value = capture();

    expect(value.binding.tools).toEqual([
      expect.objectContaining({ index: 0, name: 'alpha', definitionWinner: 'global', handlerWinner: 'global' }),
      expect.objectContaining({ index: 1, name: 'beta', definitionWinner: 'request_local', handlerWinner: 'request_local' }),
      expect.objectContaining({ index: 3, name: 'gamma', definitionWinner: 'request_local', handlerWinner: 'request_local' }),
    ]);
    expect(value.binding.tools.every((descriptor) => (
      Object.values(descriptor).every((field) => typeof field !== 'function')
    ))).toBe(true);
    expect(Object.isFrozen(value.binding)).toBe(true);
    expect(Object.isFrozen(value.binding.tools)).toBe(true);
    for (const handler of [value.globalAlpha, value.globalBeta, value.localBeta, value.localGamma]) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('rejects copied brands, prototypes, hashes, and serialized projections without exposing handlers', () => {
    class ForgedBinding {}
    const { binding, globalAlpha, globalBeta, localBeta, localGamma } = capture();
    const copied = { ...binding, tools: [...binding.tools] };
    const branded = Object.assign(Object.create(ForgedBinding.prototype), copied);
    const serialized = JSON.parse(JSON.stringify(binding)) as SealedRequestToolReplayBinding;
    const hashForged = { ...binding, factsSha256: 'a'.repeat(64) };

    for (const forged of [copied, branded, serialized, hashForged]) {
      expect(claimSealedRequestToolReplayBinding({ binding: forged, facts: facts() }))
        .toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    }
    for (const handler of [globalAlpha, globalBeta, localBeta, localGamma]) expect(handler).not.toHaveBeenCalled();
  });

  it('binds the case and every request fact without accepting restamped facts', () => {
    for (const changed of [
      { caseId: 'case-b' }, { surface: 'web' }, { isAAOAdmin: true }, { isThread: false },
      { privacy: 'public' as const }, { source: 'web_chat' }, { requestTimeMs: 1_001 }, { replayPrincipal: 'U_OTHER' },
    ]) {
      const { binding } = capture();
      expect(claimSealedRequestToolReplayBinding({ binding, facts: facts(changed) }))
        .toEqual({ valid: false, reason: 'request_facts_drift' });
    }
  });

  it('rejects a caller-supplied verified marker instead of treating it as trusted', () => {
    const { binding } = capture();
    const claimedVerified = { ...facts(), verified: true } as AddieRequestToolReplayFacts;

    expect(claimSealedRequestToolReplayBinding({ binding, facts: claimedVerified }))
      .toEqual({ valid: false, reason: 'request_facts_drift' });
  });

  it('detects missing, extra, reordered, duplicated, and mutated definitions after mint', () => {
    const mutations: Array<(value: ReturnType<typeof capture>) => void> = [
      (value) => { value.globalTools.pop(); },
      (value) => { value.globalTools.push(tool('extra')); },
      (value) => { value.globalTools.reverse(); },
      (value) => { value.globalTools.push(tool('alpha', 'duplicate')); },
      (value) => { value.requestTools.tools[0]!.description = 'mutated'; },
    ];
    for (const mutate of mutations) {
      const value = capture();
      mutate(value);
      expect(claimSealedRequestToolReplayBinding({ binding: value.binding, facts: facts() }))
        .toEqual({ valid: false, reason: 'assembly_drift' });
    }
  });

  it('binds every semantic definition field and complete nested input schemas', () => {
    const mutations: Array<(value: ReturnType<typeof capture>) => void> = [
      (value) => { value.globalTools[0]!.name = 'renamed'; },
      (value) => { value.globalTools[0]!.description = 'changed'; },
      (value) => { value.globalTools[0]!.usage_hints = 'changed hint'; },
      (value) => { value.globalTools[0]!.replaySafety = 'mutation'; },
      (value) => { delete value.globalTools[0]!.usage_hints; },
      (value) => { delete value.globalTools[0]!.replaySafety; },
      (value) => { value.globalTools[2]!.usage_hints = 'present instead of absent'; },
      (value) => { value.globalTools[2]!.replaySafety = 'external_read'; },
      (value) => { (value.globalTools[0]!.input_schema.properties.nested as { items: Array<{ safe: boolean }> }).items[0]!.safe = false; },
      (value) => { (value.globalTools[0]!.input_schema.properties.nested as { items: Array<{ safe: boolean }> }).items.push({ safe: false }); },
      (value) => { (value.globalTools[0]!.input_schema as { type: string }).type = 'array'; },
      (value) => { value.globalTools[0]!.input_schema.required!.push('other'); },
      (value) => { value.globalTools[0]!.input_schema.additionalProperties = { nested: { type: 'string' } }; },
      // `orphan` is absent from the handler intersection but remains bound.
    ];
    for (const mutate of mutations) {
      const value = capture();
      mutate(value);
      expect(claimSealedRequestToolReplayBinding({ binding: value.binding, facts: facts() }))
        .toEqual({ valid: false, reason: 'assembly_drift' });
    }
  });

  it('detects missing, swapped, and request-local shadowed handler slots after mint', () => {
    const mutations: Array<(value: ReturnType<typeof capture>) => void> = [
      (value) => { value.globalHandlers.delete('alpha'); },
      (value) => { value.globalHandlers.set('alpha', vi.fn(async () => 'swapped')); },
      (value) => { value.requestTools.handlers.delete('beta'); },
      (value) => { value.requestTools.handlers.set('beta', vi.fn(async () => 'swapped')); },
    ];
    for (const mutate of mutations) {
      const value = capture();
      mutate(value);
      expect(claimSealedRequestToolReplayBinding({ binding: value.binding, facts: facts() }))
        .toEqual({ valid: false, reason: 'assembly_drift' });
    }
  });

  it('binds all source handler slots, including handler-only off-intersection entries', () => {
    const value = capture();
    const offIntersectionReplacement = vi.fn(async () => 'replacement') as ToolHandler;
    value.globalHandlers.set('unrelated', offIntersectionReplacement);

    expect(value.binding.tools.map(({ name }) => name)).not.toContain('unrelated');
    expect(claimSealedRequestToolReplayBinding({ binding: value.binding, facts: facts() }))
      .toEqual({ valid: false, reason: 'assembly_drift' });
    expect(offIntersectionReplacement).not.toHaveBeenCalled();
    for (const handler of [value.globalAlpha, value.globalBeta, value.localBeta, value.localGamma]) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('rejects request-local accessors without invoking them during capture', () => {
    const value = setup();
    let reads = 0;
    const requestTools = { handlers: value.requestTools.handlers } as AddieRequestTools;
    Object.defineProperty(requestTools, 'tools', {
      enumerable: true,
      get: () => { reads++; return value.requestTools.tools; },
    });
    value.requestTools = requestTools;

    expect(() => captureSealedRequestToolReplayBinding(captureInput(value))).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects request-local accessors rather than reading them during capture', () => {
    const value = setup();
    const requestTools = { handlers: value.requestTools.handlers } as AddieRequestTools;
    Object.defineProperty(requestTools, 'tools', {
      enumerable: true,
      get: () => { throw new Error('must not read accessor'); },
    });
    Object.defineProperty(requestTools, 'handlers', {
      enumerable: true,
      value: value.requestTools.handlers,
    });
    value.requestTools = requestTools;

    expect(() => captureSealedRequestToolReplayBinding(captureInput(value)))
      .toThrow('requestTools.tools must be an enumerable own data property');
  });

  it('rejects proxies at every supported input boundary without executing traps', () => {
    const cases: Array<(value: ReturnType<typeof setup>, proxy: <T extends object>(target: T) => T) => void> = [
      (value, proxy) => { value.facts = proxy(value.facts); },
      (value, proxy) => { value.globalTools = proxy(value.globalTools); },
      (value, proxy) => { value.globalHandlers = proxy(value.globalHandlers); },
      (value, proxy) => { value.requestTools = proxy(value.requestTools); },
      (value, proxy) => { value.requestTools.tools = proxy(value.requestTools.tools) as AddieTool[]; },
      (value, proxy) => { value.requestTools.handlers = proxy(value.requestTools.handlers); },
      (value, proxy) => { value.globalTools[0] = proxy(value.globalTools[0]!); },
      (value, proxy) => { value.requestTools.tools[0] = proxy(value.requestTools.tools[0]!); },
      (value, proxy) => { value.globalTools[0]!.input_schema = proxy(value.globalTools[0]!.input_schema); },
      (value, proxy) => { value.globalTools[0]!.input_schema.properties = proxy(value.globalTools[0]!.input_schema.properties); },
      (value, proxy) => { (value.globalTools[0]!.input_schema.properties.nested as { items: Array<{ safe: boolean }> }).items = proxy([{ safe: true }]); },
      (value, proxy) => { value.definitionOptions = proxy({ allowedToolNames: ['alpha'] }); },
      (value, proxy) => { value.definitionOptions = { allowedToolNames: proxy(['alpha']) as string[] }; },
      (value, proxy) => { value.handlerAllowedToolNames = proxy(new Set(['alpha'])); },
    ];
    for (const configure of cases) {
      const value = setup();
      let trapCalls = 0;
      const proxy = <T extends object>(target: T): T => new Proxy(target, {
        get: () => { trapCalls++; throw new Error('proxy trap must not run'); },
        getOwnPropertyDescriptor: () => { trapCalls++; throw new Error('proxy trap must not run'); },
        getPrototypeOf: () => { trapCalls++; throw new Error('proxy trap must not run'); },
        ownKeys: () => { trapCalls++; throw new Error('proxy trap must not run'); },
      });
      configure(value, proxy);

      expect(() => captureSealedRequestToolReplayBinding(captureInput(value))).toThrow('must not be a Proxy');
      expect(trapCalls).toBe(0);
    }
  });

  it('rejects proxy projections and claim facts without executing traps', () => {
    const bindingValue = capture();
    const bindingCalls = { count: 0 };
    expect(claimSealedRequestToolReplayBinding({
      binding: trapProxy(bindingValue.binding, bindingCalls), facts: bindingValue.facts,
    })).toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    expect(bindingCalls.count).toBe(0);

    const factsValue = capture();
    const factsCalls = { count: 0 };
    expect(claimSealedRequestToolReplayBinding({
      binding: factsValue.binding, facts: trapProxy(factsValue.facts, factsCalls),
    })).toEqual({ valid: false, reason: 'request_facts_drift' });
    expect(factsCalls.count).toBe(0);
  });

  it('rejects capture and claim wrappers before any proxy trap or accessor can run', () => {
    const captureValue = setup();
    const captureCalls = { count: 0 };
    expect(() => captureSealedRequestToolReplayBinding(trapProxy(captureInput(captureValue), captureCalls)))
      .toThrow('capture input must not be a Proxy');
    expect(captureCalls.count).toBe(0);

    const getterValue = setup();
    let globalToolsReads = 0;
    const accessorCapture = { ...captureInput(getterValue) } as CaptureSealedRequestToolReplayBindingInput;
    Object.defineProperty(accessorCapture, 'globalTools', {
      enumerable: true,
      get: () => { globalToolsReads++; return getterValue.globalTools; },
    });
    expect(() => captureSealedRequestToolReplayBinding(accessorCapture)).toThrow();
    expect(globalToolsReads).toBe(0);

    const claimValue = capture();
    const claimCalls = { count: 0 };
    expect(claimSealedRequestToolReplayBinding(trapProxy({
      binding: claimValue.binding, facts: claimValue.facts,
    }, claimCalls))).toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    expect(claimCalls.count).toBe(0);

    let bindingReads = 0;
    const accessorClaim = { facts: claimValue.facts } as { binding: SealedRequestToolReplayBinding; facts: AddieRequestToolReplayFacts };
    Object.defineProperty(accessorClaim, 'binding', {
      enumerable: true,
      get: () => { bindingReads++; return claimValue.binding; },
    });
    expect(claimSealedRequestToolReplayBinding(accessorClaim))
      .toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    expect(bindingReads).toBe(0);
  });

  it('requires exact capture and claim wrapper fields and snapshots data fields once', () => {
    const value = setup();
    expect(() => captureSealedRequestToolReplayBinding({ ...captureInput(value), extra: true } as CaptureSealedRequestToolReplayBindingInput))
      .toThrow('capture input has missing or unsupported fields');
    const missingCapture = { ...captureInput(value) } as Partial<CaptureSealedRequestToolReplayBindingInput>;
    delete missingCapture.globalHandlers;
    expect(() => captureSealedRequestToolReplayBinding(missingCapture as CaptureSealedRequestToolReplayBindingInput))
      .toThrow('capture input has missing or unsupported fields');

    const { binding, facts: capturedFacts } = capture();
    expect(claimSealedRequestToolReplayBinding({ binding, facts: capturedFacts, extra: true } as never))
      .toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    expect(claimSealedRequestToolReplayBinding({ binding } as never))
      .toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
  });

  it('rejects proxy or accessor signals without reading them and accepts native abort signals', () => {
    const proxyValue = capture();
    const proxyCalls = { count: 0 };
    expect(claimSealedRequestToolReplayBinding({
      binding: proxyValue.binding,
      facts: proxyValue.facts,
      signal: trapProxy(new AbortController().signal, proxyCalls),
    })).toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    expect(proxyCalls.count).toBe(0);
    expect(claimSealedRequestToolReplayBinding({ binding: proxyValue.binding, facts: proxyValue.facts }))
      .toEqual({ valid: false, reason: 'binding_already_consumed' });

    const accessorValue = capture();
    let abortedReads = 0;
    const fakeSignal = {} as AbortSignal;
    Object.defineProperty(fakeSignal, 'aborted', {
      enumerable: true,
      get: () => { abortedReads++; return false; },
    });
    expect(claimSealedRequestToolReplayBinding({
      binding: accessorValue.binding, facts: accessorValue.facts, signal: fakeSignal,
    })).toEqual({ valid: false, reason: 'binding_unknown_or_forged' });
    expect(abortedReads).toBe(0);
    expect(claimSealedRequestToolReplayBinding({ binding: accessorValue.binding, facts: accessorValue.facts }))
      .toEqual({ valid: false, reason: 'binding_already_consumed' });
  });

  it('binds definition and handler allowlist inputs that shape production assembly', () => {
    const definitionOptions = { allowedToolNames: ['alpha'] };
    const definitionValue = setup();
    definitionValue.definitionOptions = definitionOptions;
    const definitionBinding = captureSealedRequestToolReplayBinding(captureInput(definitionValue));
    definitionOptions.allowedToolNames.push('beta');
    expect(claimSealedRequestToolReplayBinding({ binding: definitionBinding, facts: definitionValue.facts }))
      .toEqual({ valid: false, reason: 'assembly_drift' });

    const allowedNames = new Set(['alpha']);
    const handlerValue = setup();
    handlerValue.handlerAllowedToolNames = allowedNames;
    const handlerBinding = captureSealedRequestToolReplayBinding(captureInput(handlerValue));
    allowedNames.add('beta');
    expect(claimSealedRequestToolReplayBinding({ binding: handlerBinding, facts: handlerValue.facts }))
      .toEqual({ valid: false, reason: 'assembly_drift' });
  });

  it('uses monotonic elapsed time at exact expiry boundaries despite wall-clock rollback', () => {
    const beforeExpiry = capture();
    vi.advanceTimersByTime(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS - 1);
    expect(claimSealedRequestToolReplayBinding({ binding: beforeExpiry.binding, facts: facts({ requestTimeMs: beforeExpiry.facts.requestTimeMs }) }))
      .toMatchObject({ valid: true });

    const atExpiry = capture();
    vi.advanceTimersByTime(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS);
    expect(claimSealedRequestToolReplayBinding({ binding: atExpiry.binding, facts: facts({ requestTimeMs: atExpiry.facts.requestTimeMs }) }))
      .toMatchObject({ valid: true });

    const expired = capture();
    vi.advanceTimersByTime(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS + 1);
    expect(claimSealedRequestToolReplayBinding({ binding: expired.binding, facts: facts({ requestTimeMs: expired.facts.requestTimeMs }) }))
      .toEqual({ valid: false, reason: 'binding_expired' });

    const rollback = capture();
    vi.advanceTimersByTime(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS + 1);
    vi.spyOn(Date, 'now').mockReturnValue(
      rollback.facts.requestTimeMs + ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS,
    );
    expect(Date.now()).toBe(rollback.facts.requestTimeMs + ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS);
    expect(claimSealedRequestToolReplayBinding({ binding: rollback.binding, facts: facts({ requestTimeMs: rollback.facts.requestTimeMs }) }))
      .toEqual({ valid: false, reason: 'binding_expired' });
    expect(claimSealedRequestToolReplayBinding({ binding: rollback.binding, facts: facts({ requestTimeMs: rollback.facts.requestTimeMs }) }))
      .toEqual({ valid: false, reason: 'binding_already_consumed' });
  });

  it('accepts fractional monotonic timestamps and honors strict fractional TTL boundaries', () => {
    const epsilon = 0.25;
    const validateAt = (elapsedMs: number) => {
      const startMs = 100.5;
      vi.spyOn(performance, 'now').mockReturnValueOnce(startMs).mockReturnValue(startMs + elapsedMs);
      const value = capture();
      const result = claimSealedRequestToolReplayBinding({ binding: value.binding, facts: value.facts });
      vi.restoreAllMocks();
      return result;
    };

    expect(validateAt(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS - epsilon)).toMatchObject({ valid: true });
    expect(validateAt(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS)).toMatchObject({ valid: true });
    expect(validateAt(ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS + epsilon))
      .toEqual({ valid: false, reason: 'binding_expired' });
  });

  it('rejects future, negative, non-finite, and unsafe request times before mint', () => {
    const invalidRequestTimes = [
      Date.now() + 1,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const requestTimeMs of invalidRequestTimes) {
      const value = setup();
      value.facts = facts({ requestTimeMs }) as AddieRequestToolReplayFacts;
      expect(() => captureSealedRequestToolReplayBinding(captureInput(value))).toThrow();
    }
  });

  it('rejects monotonic readings above Number.MAX_SAFE_INTEGER without a caller clock', () => {
    const value = setup();
    vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER + 1);
    expect(() => captureSealedRequestToolReplayBinding(captureInput(value))).toThrow('monotonic clock is invalid');

    vi.restoreAllMocks();
    const { binding, facts: capturedFacts } = capture();
    vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER + 1);
    expect(claimSealedRequestToolReplayBinding({ binding, facts: capturedFacts }))
      .toEqual({ valid: false, reason: 'binding_clock_invalid' });
  });

  it('is one-use and fails closed for abort before any real handler can run', () => {
    const accepted = capture();
    expect(claimSealedRequestToolReplayBinding({ binding: accepted.binding, facts: facts() }))
      .toMatchObject({ valid: true, tools: accepted.binding.tools });
    expect(claimSealedRequestToolReplayBinding({ binding: accepted.binding, facts: facts() }))
      .toEqual({ valid: false, reason: 'binding_already_consumed' });

    const aborted = capture();
    const controller = new AbortController();
    controller.abort();
    expect(claimSealedRequestToolReplayBinding({
      binding: aborted.binding, facts: facts(), signal: controller.signal,
    })).toEqual({ valid: false, reason: 'binding_aborted' });

    for (const value of [accepted, aborted]) {
      for (const handler of [value.globalAlpha, value.globalBeta, value.localBeta, value.localGamma]) {
        expect(handler).not.toHaveBeenCalled();
      }
    }
  });

  it('has no fixture-oracle input, so routes, rubrics, and expected names cannot influence it', () => {
    const fixtureOracle = {
      routing: { toolSets: ['admin_billing'] }, expectedTools: ['invented_tool'], rubric: ['must disclose nothing'],
    };
    const { binding } = capture();
    void fixtureOracle;

    expect(binding.tools.map(({ name }) => name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(claimSealedRequestToolReplayBinding({ binding, facts: facts() }))
      .toMatchObject({ valid: true });
  });
});
