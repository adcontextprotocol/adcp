import type { AddieResponse, StreamEvent } from './claude-client.js';
import {
  DEFAULT_STREAM_SOFT_CAP,
  decideStreamAppend,
  planStreamStopFailureFallback,
  summarizeSlackStreamError,
  type StreamAppendDecision,
} from './slack-blocks.js';

export type SlackDmToolExecution = {
  tool_name: string;
  parameters: Record<string, unknown>;
  result: string;
};

export type SlackDmStreamChunk =
  | { type: 'plan_update'; title: string }
  | {
      type: 'task_update';
      id: string;
      title: string;
      status: 'in_progress' | 'complete' | 'error';
      details?: string;
      output?: string;
    };

export type SlackDmStreamDelivery =
  | { tag: 'open'; streamedLen: number }
  | { tag: 'cap_finalized'; streamedLen: number }
  | { tag: 'closed_uncertain'; streamedLen: number; reason: 'length_cap' | 'interrupted' };

type PendingTransition =
  | { kind: 'text_append'; decision: StreamAppendDecision }
  | { kind: 'cap_tail'; carryPart: string }
  | { kind: 'cap_stop'; carryPart: string }
  | { kind: 'tool_update' }
  | { kind: 'retry_status' }
  | { kind: 'recovery_append' }
  | { kind: 'recovery_stop' }
  | { kind: 'recovery_say' };

export type SlackDmStreamPhase =
  | { tag: 'ready' }
  | { tag: 'awaiting_effect'; effectId: string; transition: PendingTransition }
  | { tag: 'terminal' };

export interface SlackDmStreamState {
  phase: SlackDmStreamPhase;
  delivery: SlackDmStreamDelivery;
  fullText: string;
  toolsUsed: readonly string[];
  toolExecutions: readonly SlackDmToolExecution[];
  toolInvocationCount: number;
  activeToolTaskIds: readonly string[];
  planTitleSent: boolean;
  response?: AddieResponse;
  streamWasInterrupted: boolean;
  streamInterruptCategory: string;
  continuationBuffer: string;
  nextEffectOrdinal: number;
}

export interface SlackDmStreamConfig {
  softCap: number;
  continuationTail: string;
}

export type SlackDmStreamEffect =
  | {
      kind: 'stream_append';
      effectId: string;
      payload: { markdown_text: string } | { chunks: SlackDmStreamChunk[] };
    }
  | { kind: 'stream_stop'; effectId: string }
  | { kind: 'say'; effectId: string; message: string }
  | { kind: 'set_status'; effectId: string; status: string }
  | {
      kind: 'log';
      level: 'info' | 'warn' | 'error';
      fields: Record<string, unknown>;
      message: string;
    }
  | { kind: 'throw_error'; error: string };

export type SlackDmStreamFeedbackEvent = {
  type: 'effect_outcome';
  effectId: string;
  outcome: 'success' | 'failure';
  error?: unknown;
};

export type SlackDmStreamReducerEvent = StreamEvent | SlackDmStreamFeedbackEvent;

export interface SlackDmStreamReduction {
  state: SlackDmStreamState;
  effects: SlackDmStreamEffect[];
}

export type SlackDmTerminalDeliveryPlan =
  | 'continuation'
  | 'none'
  | 'delivery-notice'
  | 'full-response'
  | 'normal-stop';

export interface SlackDmStreamInterpreter {
  append(payload: Extract<SlackDmStreamEffect, { kind: 'stream_append' }>['payload']): Promise<unknown>;
  stop(): Promise<unknown>;
  say(message: string): Promise<unknown>;
  setStatus(status: string): Promise<unknown>;
  log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string): void;
}

export interface SlackDmStreamSoftCapResolution {
  value: number;
  invalid: boolean;
}

/** Parse the stream soft-cap override without reading process-global state. */
export function resolveSlackDmStreamSoftCap(
  raw: string | undefined,
  defaultValue = DEFAULT_STREAM_SOFT_CAP,
): SlackDmStreamSoftCapResolution {
  if (!raw) return { value: defaultValue, invalid: false };
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 11000) {
    return { value: defaultValue, invalid: true };
  }
  return { value: parsed, invalid: false };
}

export function createSlackDmStreamState(): SlackDmStreamState {
  return {
    phase: { tag: 'ready' },
    delivery: { tag: 'open', streamedLen: 0 },
    fullText: '',
    toolsUsed: [],
    toolExecutions: [],
    toolInvocationCount: 0,
    activeToolTaskIds: [],
    planTitleSent: false,
    streamWasInterrupted: false,
    streamInterruptCategory: '',
    continuationBuffer: '',
    nextEffectOrdinal: 1,
  };
}

/** Select the existing post-loop delivery branch without performing any I/O. */
export function planSlackDmTerminalDelivery(
  state: SlackDmStreamState,
): SlackDmTerminalDeliveryPlan {
  if (state.delivery.tag === 'cap_finalized') return 'continuation';
  if (state.delivery.tag === 'closed_uncertain') {
    if (state.streamWasInterrupted) return 'none';
    return planStreamStopFailureFallback(state.delivery.streamedLen);
  }
  return 'normal-stop';
}

/** The Bolt provider loop uses this terminal tag as its break condition. */
export function shouldStopSlackDmStream(state: SlackDmStreamState): boolean {
  return state.phase.tag === 'terminal';
}

function formatToolTaskTitle(toolName: string): string {
  return toolName.trim() ? `Call ${toolName}` : 'Call Addie tool';
}

function buildPlanTitleChunk(): SlackDmStreamChunk {
  return { type: 'plan_update', title: 'Addie is working' };
}

function buildToolTaskChunk(
  taskId: string,
  toolName: string,
  status: 'in_progress' | 'complete' | 'error',
): SlackDmStreamChunk {
  return {
    type: 'task_update',
    id: taskId,
    title: formatToolTaskTitle(toolName),
    status,
    ...(status === 'in_progress'
      ? { details: `Using Addie tool: ${toolName}` }
      : { output: status === 'error' ? `Tool failed: ${toolName}` : `Tool completed: ${toolName}` }),
  };
}

function scheduleAsyncEffect(
  state: SlackDmStreamState,
  transition: PendingTransition,
  makeEffect: (effectId: string) => SlackDmStreamEffect,
  precedingEffects: SlackDmStreamEffect[] = [],
): SlackDmStreamReduction {
  const effectId = `stream_effect_${state.nextEffectOrdinal}`;
  return {
    state: {
      ...state,
      phase: { tag: 'awaiting_effect', effectId, transition },
      nextEffectOrdinal: state.nextEffectOrdinal + 1,
    },
    effects: [...precedingEffects, makeEffect(effectId)],
  };
}

function beginCapFinalization(
  state: SlackDmStreamState,
  carryPart: string,
  config: SlackDmStreamConfig,
  precedingEffects: SlackDmStreamEffect[] = [],
): SlackDmStreamReduction {
  const streamedLen = state.delivery.streamedLen;
  const capLog: SlackDmStreamEffect = {
    kind: 'log',
    level: 'info',
    fields: {
      streamedLen,
      softCap: config.softCap,
      carryLen: carryPart.length,
      fullTextLen: state.fullText.length,
    },
    message: 'Addie Bolt: Stream length cap reached — finalizing and switching to continuation',
  };
  return scheduleAsyncEffect(
    state,
    { kind: 'cap_tail', carryPart },
    effectId => ({
      kind: 'stream_append',
      effectId,
      payload: { markdown_text: config.continuationTail },
    }),
    [...precedingEffects, capLog],
  );
}

function scheduleCapStop(
  state: SlackDmStreamState,
  carryPart: string,
  precedingEffects: SlackDmStreamEffect[] = [],
): SlackDmStreamReduction {
  const closedState: SlackDmStreamState = {
    ...state,
    delivery: {
      tag: 'closed_uncertain',
      streamedLen: state.delivery.streamedLen,
      reason: 'length_cap',
    },
  };
  return scheduleAsyncEffect(
    closedState,
    { kind: 'cap_stop', carryPart },
    effectId => ({ kind: 'stream_stop', effectId }),
    precedingEffects,
  );
}

function scheduleRecoveryStop(
  state: SlackDmStreamState,
  precedingEffects: SlackDmStreamEffect[] = [],
): SlackDmStreamReduction {
  const closedState: SlackDmStreamState = {
    ...state,
    delivery: {
      tag: 'closed_uncertain',
      streamedLen: state.delivery.streamedLen,
      reason: 'interrupted',
    },
  };
  return scheduleAsyncEffect(
    closedState,
    { kind: 'recovery_stop' },
    effectId => ({ kind: 'stream_stop', effectId }),
    precedingEffects,
  );
}

function reduceEffectOutcome(
  state: SlackDmStreamState,
  event: SlackDmStreamFeedbackEvent,
  config: SlackDmStreamConfig,
): SlackDmStreamReduction {
  if (state.phase.tag !== 'awaiting_effect' || state.phase.effectId !== event.effectId) {
    return {
      state,
      effects: [{
        kind: 'log',
        level: 'warn',
        fields: { effectId: event.effectId, phase: state.phase.tag },
        message: 'Addie Bolt: Ignoring stale stream effect outcome',
      }],
    };
  }

  const transition = state.phase.transition;
  const readyState: SlackDmStreamState = { ...state, phase: { tag: 'ready' } };

  if (transition.kind === 'text_append') {
    const appendSucceeded = event.outcome === 'success';
    const nextState: SlackDmStreamState = appendSucceeded
      ? {
          ...readyState,
          delivery: {
            tag: 'open',
            streamedLen: readyState.delivery.streamedLen + transition.decision.appendPart.length,
          },
        }
      : readyState;
    const failureLog: SlackDmStreamEffect[] = appendSucceeded ? [] : [{
      kind: 'log',
      level: 'warn',
      fields: { streamError: event.error },
      message: 'Addie Bolt: Stream append failed for chunk, continuing',
    }];
    return transition.decision.shouldFinalize
      ? beginCapFinalization(nextState, transition.decision.carryPart, config, failureLog)
      : { state: nextState, effects: failureLog };
  }

  if (transition.kind === 'cap_tail') {
    const failureLog: SlackDmStreamEffect[] = event.outcome === 'failure' ? [{
      kind: 'log',
      level: 'warn',
      fields: { appendError: event.error },
      message: 'Addie Bolt: Continuation tail marker append failed',
    }] : [];
    return scheduleCapStop(readyState, transition.carryPart, failureLog);
  }

  if (transition.kind === 'cap_stop') {
    if (event.outcome === 'success') {
      return {
        state: {
          ...readyState,
          delivery: { tag: 'cap_finalized', streamedLen: readyState.delivery.streamedLen },
          continuationBuffer: transition.carryPart,
        },
        effects: [],
      };
    }
    return {
      state: readyState,
      effects: [{
        kind: 'log',
        level: 'warn',
        fields: { stopError: event.error },
        message: 'Addie Bolt: Stream stop at length cap failed — falling through to post-loop fallback',
      }],
    };
  }

  if (transition.kind === 'recovery_append') {
    const failureLog: SlackDmStreamEffect[] = event.outcome === 'failure' ? [{
      kind: 'log',
      level: 'warn',
      fields: { appendError: event.error },
      message: 'Addie Bolt: Recovery banner append failed',
    }] : [];
    return scheduleRecoveryStop(readyState, failureLog);
  }

  if (transition.kind === 'recovery_stop') {
    return {
      state: { ...readyState, phase: { tag: 'terminal' } },
      effects: event.outcome === 'failure' ? [{
        kind: 'log',
        level: 'warn',
        fields: { stopError: event.error },
        message: 'Addie Bolt: Streamer stop after interruption failed',
      }] : [],
    };
  }

  if (transition.kind === 'recovery_say') {
    return {
      state: { ...readyState, phase: { tag: 'terminal' } },
      effects: event.outcome === 'failure' ? [{
        kind: 'log',
        level: 'warn',
        fields: { sayError: event.error },
        message: 'Addie Bolt: Recovery banner say() failed after stream close',
      }] : [],
    };
  }

  return { state: readyState, effects: [] };
}

export function reduceSlackDmStreamEvent(
  state: SlackDmStreamState,
  event: SlackDmStreamReducerEvent,
  config: SlackDmStreamConfig,
): SlackDmStreamReduction {
  if (event.type === 'effect_outcome') {
    return reduceEffectOutcome(state, event, config);
  }
  if (state.phase.tag !== 'ready') {
    return {
      state,
      effects: [{
        kind: 'log',
        level: 'warn',
        fields: { eventType: event.type, phase: state.phase.tag },
        message: 'Addie Bolt: Ignoring stream event while an effect is pending',
      }],
    };
  }

  if (event.type === 'text') {
    const textState: SlackDmStreamState = { ...state, fullText: state.fullText + event.text };
    if (textState.delivery.tag === 'cap_finalized') {
      return {
        state: { ...textState, continuationBuffer: textState.continuationBuffer + event.text },
        effects: [],
      };
    }
    if (textState.delivery.tag === 'closed_uncertain') {
      return { state: textState, effects: [] };
    }

    const decision = decideStreamAppend(textState.delivery.streamedLen, event.text, config.softCap);
    if (!decision.appendPart) {
      return decision.shouldFinalize
        ? beginCapFinalization(textState, decision.carryPart, config)
        : { state: textState, effects: [] };
    }
    return scheduleAsyncEffect(
      textState,
      { kind: 'text_append', decision },
      effectId => ({
        kind: 'stream_append',
        effectId,
        payload: { markdown_text: decision.appendPart },
      }),
    );
  }

  if (event.type === 'tool_start') {
    const toolInvocationCount = state.toolInvocationCount + 1;
    const taskId = `${event.tool_name}_${toolInvocationCount}`;
    const toolState: SlackDmStreamState = {
      ...state,
      toolsUsed: [...state.toolsUsed, event.tool_name],
      toolInvocationCount,
      activeToolTaskIds: [...state.activeToolTaskIds, taskId],
    };
    if (toolState.delivery.tag !== 'open') return { state: toolState, effects: [] };

    const chunks: SlackDmStreamChunk[] = [];
    if (!toolState.planTitleSent) chunks.push(buildPlanTitleChunk());
    chunks.push(buildToolTaskChunk(taskId, event.tool_name, 'in_progress'));
    return scheduleAsyncEffect(
      { ...toolState, planTitleSent: true },
      { kind: 'tool_update' },
      effectId => ({ kind: 'stream_append', effectId, payload: { chunks } }),
    );
  }

  if (event.type === 'tool_end') {
    const activeToolTaskIds = [...state.activeToolTaskIds];
    const taskId = activeToolTaskIds.pop() || event.tool_name;
    const toolState: SlackDmStreamState = {
      ...state,
      activeToolTaskIds,
      toolExecutions: [...state.toolExecutions, {
        tool_name: event.tool_name,
        parameters: {},
        result: event.result,
      }],
    };
    if (toolState.delivery.tag !== 'open') return { state: toolState, effects: [] };
    return scheduleAsyncEffect(
      toolState,
      { kind: 'tool_update' },
      effectId => ({
        kind: 'stream_append',
        effectId,
        payload: {
          chunks: [buildToolTaskChunk(taskId, event.tool_name, event.is_error ? 'error' : 'complete')],
        },
      }),
    );
  }

  if (event.type === 'retry') {
    return scheduleAsyncEffect(
      state,
      { kind: 'retry_status' },
      effectId => ({
        kind: 'set_status',
        effectId,
        status: `${event.reason}, retrying (${event.attempt}/${event.maxRetries})...`,
      }),
    );
  }

  if (event.type === 'stream_error') {
    const errorSummary = summarizeSlackStreamError(event.reason);
    const interruptedState: SlackDmStreamState = {
      ...state,
      streamWasInterrupted: true,
      streamInterruptCategory: errorSummary.category,
    };
    const interruptLog: SlackDmStreamEffect = {
      kind: 'log',
      level: 'warn',
      fields: {
        category: errorSummary.category,
        deltasBeforeError: event.deltasBeforeError,
        fullTextLength: state.fullText.length,
        streamFinalizedEarly: state.delivery.tag === 'cap_finalized',
      },
      message: 'Addie Bolt: Stream interrupted mid-reply — discarding partial turn',
    };
    if (state.delivery.tag !== 'open') {
      return scheduleAsyncEffect(
        interruptedState,
        { kind: 'recovery_say' },
        effectId => ({ kind: 'say', effectId, message: errorSummary.followupRecoveryText }),
        [interruptLog],
      );
    }
    return scheduleAsyncEffect(
      interruptedState,
      { kind: 'recovery_append' },
      effectId => ({
        kind: 'stream_append',
        effectId,
        payload: { markdown_text: errorSummary.inlineRecoveryText },
      }),
      [interruptLog],
    );
  }

  if (event.type === 'done') {
    return { state: { ...state, response: event.response }, effects: [] };
  }

  return { state, effects: [{ kind: 'throw_error', error: event.error }] };
}

async function executeEffect(
  effect: SlackDmStreamEffect,
  interpreter: SlackDmStreamInterpreter,
): Promise<SlackDmStreamFeedbackEvent | undefined> {
  if (effect.kind === 'log') {
    interpreter.log(effect.level, effect.fields, effect.message);
    return undefined;
  }
  if (effect.kind === 'throw_error') throw new Error(effect.error);

  try {
    if (effect.kind === 'stream_append') await interpreter.append(effect.payload);
    else if (effect.kind === 'stream_stop') await interpreter.stop();
    else if (effect.kind === 'say') await interpreter.say(effect.message);
    else await interpreter.setStatus(effect.status);
    return { type: 'effect_outcome', effectId: effect.effectId, outcome: 'success' };
  } catch (error) {
    return { type: 'effect_outcome', effectId: effect.effectId, outcome: 'failure', error };
  }
}

/**
 * Execute one provider event and all of the ordered Slack effects it causes.
 * Async outcomes are fed back through the reducer before the next effect runs.
 */
export async function interpretSlackDmStreamEvent(
  state: SlackDmStreamState,
  event: StreamEvent,
  config: SlackDmStreamConfig,
  interpreter: SlackDmStreamInterpreter,
): Promise<SlackDmStreamState> {
  let reduction = reduceSlackDmStreamEvent(state, event, config);
  while (true) {
    let feedback: SlackDmStreamFeedbackEvent | undefined;
    for (const effect of reduction.effects) {
      const result = await executeEffect(effect, interpreter);
      if (result) {
        feedback = result;
        break;
      }
    }
    if (!feedback) return reduction.state;
    reduction = reduceSlackDmStreamEvent(reduction.state, feedback, config);
  }
}
