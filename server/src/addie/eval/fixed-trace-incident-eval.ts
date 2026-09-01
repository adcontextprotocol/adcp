import { createHash } from 'node:crypto';
import type { GenerateContentResponse } from '@google/genai';
import {
  AddieClaudeClient,
  type AddieResponse,
  type StreamEvent,
} from '../claude-client.js';
import {
  MAX_INPUT_LENGTH,
  MAX_OUTPUT_LENGTH,
  OUTPUT_TRUNCATION_SUFFIX,
  sanitizeInput,
} from '../security.js';
import type {
  ModelProvider,
  ModelProviderId,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../model-providers/model-provider.js';
import {
  AnthropicModelProvider,
  type AnthropicMessagesTransport,
} from '../model-providers/anthropic-provider.js';
import {
  GoogleGenerateContentProvider,
  GOOGLE_ROUTER_MODEL,
  type GoogleGenerateContentTransport,
} from '../model-providers/google-generate-content-provider.js';
import {
  FIXED_TRACE_SUITE,
  FIXED_TRACE_SUITE_VERSION,
  fixedTraceSuiteSha256,
  type FixedTraceCase,
} from './fixed-trace-suite.js';

export const FIXED_TRACE_INCIDENT_EVAL_VERSION = 'addie-fixed-trace-incidents-v1';

const LEGACY_INPUT_BOUNDARY = 4_000;
const PROVIDERS = ['anthropic', 'google'] as const satisfies readonly ModelProviderId[];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function responseFixture(): string {
  return [
    '## Long-form delivery fixture',
    '',
    'The cobalt release gate requires an owner approval. Retain the evidence appendix for 48 hours. The final recommendation names the verified handoff.',
    '',
    ...Array.from(
      { length: 360 },
      (_, index) => `- [Delivery checkpoint ${String(index + 1).padStart(3, '0')}](https://fixture.test/checkpoint/${index + 1}): synthetic evidence, accountable owner, review status, and implementation handoff`,
    ),
  ].join('\n');
}

const LONG_FORM_RESPONSE_FIXTURE = responseFixture();

/**
 * Captures a real adapter's exact prepared request while its injected transport
 * supplies deterministic, no-network responses.
 */
class CapturingProvider implements ModelProvider {
  readonly prepared: PreparedModelInvocation[] = [];

  constructor(
    private readonly delegate: ModelProvider,
  ) {}

  get id(): ModelProviderId { return this.delegate.id; }
  get capabilities() { return this.delegate.capabilities; }

  prepare(request: ModelRequest): PreparedModelInvocation {
    return this.delegate.prepare(request);
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    for await (const event of this.delegate.respond(request, {
      ...options,
      beforeDispatch: async (prepared) => {
        this.prepared.push(prepared);
        await options.beforeDispatch?.(prepared);
      },
    })) {
      yield event;
    }
  }
}

function anthropicProvider(): CapturingProvider {
  const response = {
    id: 'fixed-trace-anthropic-response',
    model: 'claude-fixed-trace-eval',
    content: [{ type: 'text', text: LONG_FORM_RESPONSE_FIXTURE }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000, output_tokens: 2_000 },
  };
  const transport: AnthropicMessagesTransport = {
    beta: {
      messages: {
        create: async () => response,
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            for (const text of [
              LONG_FORM_RESPONSE_FIXTURE.slice(0, 2_000),
              LONG_FORM_RESPONSE_FIXTURE.slice(2_000, 7_000),
              LONG_FORM_RESPONSE_FIXTURE.slice(7_000),
            ]) {
              if (text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
            }
          },
          finalMessage: async () => response,
        }),
      },
    },
  };
  return new CapturingProvider(new AnthropicModelProvider('', transport, { transportMaxRetries: 0 }));
}

function googleProvider(): CapturingProvider {
  const response = {
    responseId: 'fixed-trace-google-response',
    modelVersion: GOOGLE_ROUTER_MODEL,
    usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 2_000 },
    candidates: [{
      finishReason: 'STOP',
      content: { role: 'model', parts: [{ text: LONG_FORM_RESPONSE_FIXTURE }] },
    }],
  } as GenerateContentResponse;
  const transport: GoogleGenerateContentTransport = {
    models: {
      generateContent: async () => response,
    },
  };
  return new CapturingProvider(new GoogleGenerateContentProvider('', transport));
}

interface DeliveryObservation {
  response: AddieResponse;
  emittedText: string;
  prepared: PreparedModelInvocation;
}

async function deliver(
  trace: FixedTraceCase,
  provider: ModelProviderId,
  delivery: 'json' | 'stream',
): Promise<DeliveryObservation> {
  const adapter = provider === 'anthropic' ? anthropicProvider() : googleProvider();
  const model = provider === 'anthropic' ? 'claude-fixed-trace-eval' : GOOGLE_ROUTER_MODEL;
  const client = new AddieClaudeClient('', model, undefined, {
    provider: adapter,
  });
  const sanitized = sanitizeInput(trace.request.message).sanitized;
  if (delivery === 'json') {
    const response = await client.processMessage(sanitized, undefined, undefined, undefined, {
      executionMode: 'evaluation',
    });
    const prepared = adapter.prepared.at(-1);
    if (!prepared) throw new Error('Fixed trace incident provider was not dispatched');
    return { response, emittedText: response.text, prepared };
  }

  const events: StreamEvent[] = [];
  for await (const event of client.processMessageStream(sanitized, undefined, undefined, {
    executionMode: 'evaluation',
  })) events.push(event);
  const response = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done')?.response;
  if (!response) throw new Error('Fixed trace incident stream did not terminate');
  const prepared = adapter.prepared.at(-1);
  if (!prepared) throw new Error('Fixed trace incident provider was not dispatched');
  return {
    response,
    emittedText: events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    prepared,
  };
}

function providerRequestContains(
  prepared: PreparedModelInvocation,
  markers: readonly string[],
): boolean {
  const serialized = JSON.stringify(prepared.providerRequest);
  return markers.every((marker) => serialized.includes(marker));
}

function validMarkdownDeliveryBoundary(text: string): boolean {
  const suffix = `\n\n${OUTPUT_TRUNCATION_SUFFIX}`;
  if (!text.endsWith(suffix) || text.includes('\uFFFD')) return false;
  const body = text.slice(0, -suffix.length);
  let cursor = 0;
  while (true) {
    const open = body.indexOf('[', cursor);
    if (open === -1) break;
    const labelEnd = body.indexOf('](', open + 1);
    const destinationEnd = labelEnd === -1 ? -1 : body.indexOf(')', labelEnd + 2);
    if (labelEnd === -1 || destinationEnd === -1) return false;
    cursor = destinationEnd + 1;
  }
  return /^- \[Delivery checkpoint \d{3}\]\(https:\/\/fixture\.test\/checkpoint\/\d+\): synthetic evidence, accountable owner, review status, and implementation handoff$/.test(body.split('\n').at(-1) ?? '');
}

function terminalProjection(response: AddieResponse) {
  return {
    text: response.text,
    toolsUsed: response.tools_used,
    toolExecutions: response.tool_executions,
    flagged: response.flagged,
    flagReason: response.flag_reason,
    activeRuleIds: response.active_rule_ids,
    modelExecution: response.model_execution,
    usage: response.usage,
    // Capacity/reserve fields are operational-admission metadata. Isolated
    // evaluation intentionally does not exercise that production-only path.
  };
}

function providerNeutralProjection(response: AddieResponse) {
  const { modelExecution, ...terminal } = terminalProjection(response);
  return {
    ...terminal,
    modelExecution: modelExecution.source === 'provider'
      ? {
          source: modelExecution.source,
          modelResolution: modelExecution.model_resolution,
          fallbackReason: modelExecution.fallback_reason,
        }
      : { source: modelExecution.source, reason: modelExecution.reason },
  };
}

export interface FixedTraceIncidentEvalArtifact {
  artifactVersion: typeof FIXED_TRACE_INCIDENT_EVAL_VERSION;
  traceSuiteVersion: typeof FIXED_TRACE_SUITE_VERSION;
  traceSuiteSha256: string;
  fixtureSha256: string;
  traceId: string;
  noNetwork: true;
  passed: boolean;
  dimensions: {
    inputAboveLegacyBoundary: boolean;
    inputWithinCurrentBoundary: boolean;
    inputPreservedBySanitizer: boolean;
    latePromptCoverage: boolean;
    retainedCoverage: boolean;
    retainedLength: boolean;
    markdownBoundary: boolean;
    jsonStreamParity: boolean;
    providerParity: boolean;
  };
  deliveries: Array<{
    provider: ModelProviderId;
    json: { outputLength: number; outputSha256: string; providerRequestSha256: string };
    stream: { outputLength: number; outputSha256: string; providerRequestSha256: string } | null;
  }>;
}

/** Run the known incident through real adapters backed by deterministic transports. */
export async function runFixedTraceIncidentEval(): Promise<FixedTraceIncidentEvalArtifact> {
  const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'long-form-deck-delivery');
  if (!trace?.incident) throw new Error('Missing long-form fixed trace incident fixture');
  const sanitized = sanitizeInput(trace.request.message);
  const deliveries: FixedTraceIncidentEvalArtifact['deliveries'] = [];
  const perProvider: Array<{
    provider: ModelProviderId;
    json: DeliveryObservation;
    stream: DeliveryObservation | null;
  }> = [];

  for (const provider of PROVIDERS) {
    const json = await deliver(trace, provider, 'json');
    const stream = provider === 'anthropic' ? await deliver(trace, provider, 'stream') : null;
    perProvider.push({ provider, json, stream });
    deliveries.push({
      provider,
      json: {
        outputLength: json.response.text.length,
        outputSha256: sha256(json.response.text),
        providerRequestSha256: sha256(JSON.stringify(json.prepared.providerRequest)),
      },
      stream: stream ? {
        outputLength: stream.response.text.length,
        outputSha256: sha256(stream.response.text),
        providerRequestSha256: sha256(JSON.stringify(stream.prepared.providerRequest)),
      } : null,
    });
  }

  const jsonStreamParity = perProvider.filter(({ stream }) => stream !== null).every(({ json, stream }) => (
    stream !== null
    && json.emittedText === json.response.text
    && stream.emittedText === stream.response.text
    && JSON.stringify(terminalProjection(json.response)) === JSON.stringify(terminalProjection(stream.response))
  ));
  const providerParity = perProvider.every(({ provider, json }) => (
    json.response.model_execution.source === 'provider'
    && json.response.model_execution.requested_provider === provider
    && json.response.model_execution.provider === provider
    && JSON.stringify(providerNeutralProjection(json.response))
      === JSON.stringify(providerNeutralProjection(perProvider[0].json.response))
  ));
  const forwarded = perProvider.every(({ json, stream }) => (
    providerRequestContains(json.prepared, trace.incident!.latePromptMarkers)
    && (stream === null || providerRequestContains(stream.prepared, trace.incident!.latePromptMarkers))
  ));
  const delivered = perProvider.flatMap(({ json, stream }) => [json.response.text, ...(stream ? [stream.response.text] : [])]);
  const dimensions = {
    inputAboveLegacyBoundary: trace.request.message.length > LEGACY_INPUT_BOUNDARY,
    inputWithinCurrentBoundary: trace.request.message.length <= MAX_INPUT_LENGTH,
    inputPreservedBySanitizer: sanitized.sanitized === trace.request.message && !sanitized.flagged,
    latePromptCoverage: forwarded,
    retainedCoverage: delivered.every((text) => trace.incident!.requiredDeliveredMarkers.every((marker) => text.includes(marker))),
    retainedLength: delivered.every((text) => text.length >= trace.incident!.minimumDeliveredCharacters && text.length <= MAX_OUTPUT_LENGTH),
    markdownBoundary: delivered.every(validMarkdownDeliveryBoundary),
    jsonStreamParity,
    providerParity,
  };
  return {
    artifactVersion: FIXED_TRACE_INCIDENT_EVAL_VERSION,
    traceSuiteVersion: FIXED_TRACE_SUITE_VERSION,
    traceSuiteSha256: fixedTraceSuiteSha256(),
    fixtureSha256: sha256(LONG_FORM_RESPONSE_FIXTURE),
    traceId: trace.id,
    noNetwork: true,
    passed: Object.values(dimensions).every(Boolean),
    dimensions,
    deliveries,
  };
}
