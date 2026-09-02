import type { GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import {
  executeFixedTraceToolLoop,
  FixedTraceToolLoopBoundaryError,
} from '../../../src/addie/eval/fixed-trace-tool-loop.js';
import {
  FIXED_TRACE_SUITE,
  type FixedTraceCase,
} from '../../../src/addie/eval/fixed-trace-suite.js';
import {
  AnthropicModelProvider,
  type AnthropicMessagesTransport,
} from '../../../src/addie/model-providers/anthropic-provider.js';
import {
  GOOGLE_ROUTER_MODEL,
  GoogleGenerateContentProvider,
} from '../../../src/addie/model-providers/google-generate-content-provider.js';
import type { ModelRequest } from '../../../src/addie/model-providers/model-provider.js';
import type { AddieTool } from '../../../src/addie/types.js';
import { FAILED_LOOKUP_EVIDENCE_RESPONSE } from '../../../src/addie/failed-lookup-evidence.js';

function trace(id: string): FixedTraceCase {
  const value = FIXED_TRACE_SUITE.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Missing trace ${id}`);
  return value;
}

function request(model: string): ModelRequest {
  return {
    model,
    system: [{ text: 'Follow the synthetic fixed-trace fixture.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Run the fixture.' }] }],
    tools: [],
    maxOutputTokens: 300,
  };
}

function tool(name: string, required: string[] = []): AddieTool {
  return {
    name,
    description: `Synthetic ${name} fixture.`,
    replaySafety: name.startsWith('confirm_') ? 'mutation' : 'pure_local',
    input_schema: {
      type: 'object',
      properties: { invoice_id: { type: 'string' }, query: { type: 'string' } },
      required,
      additionalProperties: false,
    },
  };
}

function anthropicResponse(
  content: Array<Record<string, unknown>>,
  stopReason: string,
  id: string,
): Record<string, unknown> {
  return {
    id,
    model: 'claude-test',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function googleResponse(overrides: Record<string, unknown>): GenerateContentResponse {
  return {
    responseId: 'google-response',
    modelVersion: GOOGLE_ROUTER_MODEL,
    candidates: [{
      finishReason: 'STOP',
      content: { role: 'model', parts: [{ text: 'Done.' }] },
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    ...overrides,
  } as GenerateContentResponse;
}

describe('executeFixedTraceToolLoop', () => {
  it('executes only the inert corpus result through the Anthropic adapter', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'task model' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'text', text: 'AdCP uses task-based interactions.',
      }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const beforeDispatch = vi.fn();

    const result = await executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      trace('knowledge-task-model'),
      [tool('search_docs', ['query']), tool('get_doc')],
      { beforeDispatch },
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].messages[2].content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'tool_1',
      content: expect.stringMatching(
        /<tool_result_evidence status="ok">\nOfficial docs: A buyer agent calls a defined task on a seller agent with structured input\. The seller returns that task's structured response, including its status\.\n<\/tool_result_evidence>/,
      ),
    }]);
    expect(result.text).toBe('AdCP uses task-based interactions.');
    expect(result.localReplacementReason).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(result.tools).toEqual([{
      sequence: 1,
      name: 'search_docs',
      description: 'Synthetic search_docs fixture.',
      input: { query: 'task model' },
      effect: 'read',
      policyDisposition: 'allowed',
      resultStatus: 'ok',
      simulated: true,
    }]);
    expect(Object.isFrozen(result.tools[0].input)).toBe(true);
    expect(result.invocations).toHaveLength(2);
  });

  it('replaces unsupported provider prose after the synthetic source lookup fails', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'package identifiers' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'text', text: 'The docs confirm it. See https://invented.example/docs.',
      }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);

    const result = await executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      trace('knowledge-tool-error'),
      [tool('search_docs', ['query'])],
    );

    expect(result.text).toBe(FAILED_LOOKUP_EVIDENCE_RESPONSE);
    expect(result.text).not.toContain('invented.example');
    expect(result.localReplacementReason).toBe(
      'Failed lookup evidence boundary enforced (search_docs)',
    );
    expect(result.tools).toEqual([expect.objectContaining({
      name: 'search_docs',
      resultStatus: 'recoverable_error',
    })]);
  });

  it('simulates an explicitly confirmed mutation through the Gemini adapter', async () => {
    const generateContent = vi.fn()
      .mockResolvedValueOnce(googleResponse({
        responseId: 'google-tool',
        candidates: [{
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                id: 'call_1',
                name: 'confirm_send_invoice',
                args: { invoice_id: 'synthetic-invoice' },
              },
              thoughtSignature: 'opaque-signature',
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(googleResponse({
        responseId: 'google-final',
        candidates: [{
          finishReason: 'STOP',
          content: { role: 'model', parts: [{ text: 'The synthetic invoice was sent.' }] },
        }],
      }));
    const provider = new GoogleGenerateContentProvider('unused', {
      models: { generateContent },
    });

    const result = await executeFixedTraceToolLoop(
      provider,
      request(GOOGLE_ROUTER_MODEL),
      trace('billing-invoice-confirmed'),
      [tool('confirm_send_invoice', ['invoice_id'])],
    );

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1][0].contents[2]).toEqual({
      role: 'user',
      parts: [{
        functionResponse: {
          id: 'call_1',
          name: 'confirm_send_invoice',
          response: { output: 'Synthetic simulation: invoice sent.' },
        },
      }],
    });
    expect(result.tools).toEqual([expect.objectContaining({
      name: 'confirm_send_invoice',
      effect: 'mutation',
      policyDisposition: 'allowed',
      simulated: true,
    })]);
  });

  it('preserves the full meeting union for a confirmed long three-workflow request', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_1', name: 'schedule_meeting', input: { query: 'recurring governance meeting' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_2', name: 'add_meeting_attendee', input: { query: 'new attendee' },
      }], 'tool_use', 'msg_2'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_3', name: 'rsvp_to_meeting', input: { query: 'accepted' },
      }], 'tool_use', 'msg_3'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_4', name: 'update_topic_subscriptions', input: { query: 'governance topics' },
      }], 'tool_use', 'msg_4'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'text', text: 'Scheduled the recurring meeting, added the attendee, recorded the RSVP, and updated topic subscriptions.',
      }], 'end_turn', 'msg_5'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const meetingTrace = trace('meeting-full-administration-confirmed');

    const result = await executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      meetingTrace,
      meetingTrace.toolFixtures.map((fixture) => tool(fixture.name, ['query'])),
    );

    expect(create).toHaveBeenCalledTimes(5);
    expect(result.tools.map((execution) => execution.name)).toEqual([
      'schedule_meeting', 'add_meeting_attendee', 'rsvp_to_meeting', 'update_topic_subscriptions',
    ]);
    expect(result.tools.every((execution) => execution.policyDisposition === 'allowed' && execution.simulated)).toBe(true);
    expect(result.text).toContain('updated topic subscriptions');
  });

  it('blocks an unconfirmed mutation while still returning safe model context', async () => {
    const unconfirmed = structuredClone(trace('billing-invoice-confirmed'));
    unconfirmed.expectation.mutationAuthorization = 'none';
    const create = vi.fn()
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'tool_use', id: 'tool_1', name: 'confirm_send_invoice', input: { invoice_id: 'synthetic' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(anthropicResponse([{
        type: 'text', text: 'I did not send the invoice.',
      }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);

    const result = await executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      unconfirmed,
      [tool('confirm_send_invoice', ['invoice_id'])],
    );

    expect(create.mock.calls[1][0].messages[2].content).toEqual([expect.objectContaining({
      type: 'tool_result',
      content: 'Error: Tool execution blocked by policy',
      is_error: true,
    })]);
    expect(result.tools[0]).toMatchObject({
      policyDisposition: 'blocked',
      simulated: true,
    });
  });

  it('rejects malformed calls before supplying any fixture result', async () => {
    const create = vi.fn().mockResolvedValue(anthropicResponse([{
      type: 'tool_use', id: 'tool_1', name: 'search_docs', input: {},
    }], 'tool_use', 'msg_1'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);

    await expect(executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      trace('knowledge-task-model'),
      [tool('search_docs', ['query']), tool('get_doc')],
    )).rejects.toEqual(new FixedTraceToolLoopBoundaryError('tool_input_invalid'));
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects duplicate mutation names within one provider response before execution', async () => {
    const duplicateMutationTrace = structuredClone(trace('knowledge-task-model'));
    duplicateMutationTrace.toolFixtures = [
      {
        name: 'confirm_send_invoice',
        effect: 'mutation',
        resultStatus: 'ok',
        result: 'Synthetic simulation: invoice sent.',
      },
      {
        name: 'get_doc',
        effect: 'read',
        resultStatus: 'ok',
        result: 'Synthetic document.',
      },
    ];
    duplicateMutationTrace.expectation.mutationAuthorization = 'confirmed';
    const create = vi.fn().mockResolvedValue(anthropicResponse([
      {
        type: 'tool_use', id: 'tool_1', name: 'confirm_send_invoice', input: { invoice_id: 'synthetic' },
      },
      {
        type: 'tool_use', id: 'tool_2', name: 'confirm_send_invoice', input: { invoice_id: 'synthetic' },
      },
    ], 'tool_use', 'msg_1'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);

    await expect(executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      duplicateMutationTrace,
      [tool('confirm_send_invoice', ['invoice_id']), tool('get_doc')],
    )).rejects.toEqual(new FixedTraceToolLoopBoundaryError('duplicate_tool_call'));
    expect(create).toHaveBeenCalledOnce();
  });

  it('requires an exact one-to-one fixture and schema registry', async () => {
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create: vi.fn() } },
    } as unknown as AnthropicMessagesTransport);

    await expect(executeFixedTraceToolLoop(
      provider,
      request('claude-test'),
      trace('knowledge-task-model'),
      [tool('search_docs')],
    )).rejects.toEqual(new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch'));
  });
});
