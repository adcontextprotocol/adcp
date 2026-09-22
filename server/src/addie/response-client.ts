import type { AddieClaudeClient, AddieResponse, ProcessMessageOptions, StreamEvent } from './claude-client.js';
import { AddieModelConfig } from '../config/models.js';
import { createLogger } from '../logger.js';
import { GoogleGenerateContentProvider, GOOGLE_ROUTER_MODEL } from './model-providers/google-generate-content-provider.js';
import { getResponseProviderPolicy } from './response-provider-policy.js';

export type ResponseClient = Pick<AddieClaudeClient, 'processMessageStream'>
  & Partial<Pick<AddieClaudeClient, 'processMessage'>>
  & Partial<Pick<AddieClaudeClient, 'getRegisteredTools' | 'forkForGeminiDirect'>>;
type Surface = 'web' | 'slack' | 'mcp' | 'email' | 'tavus';
const logger = createLogger('addie-response-provider');
const clients = new WeakMap<ResponseClient, AddieClaudeClient>();

function isProviderFailure(response: AddieResponse): boolean {
  return response.model_execution.source === 'local'
    && ['provider_error', 'stream_interrupted'].includes(response.model_execution.reason);
}

function fallbackResponse(response: AddieResponse): AddieResponse {
  return {
    ...response,
    model_execution: response.model_execution.source === 'provider' ? {
      ...response.model_execution,
      requested_provider: 'google', requested_model: GOOGLE_ROUTER_MODEL,
      model_resolution: 'fallback', fallback_reason: 'primary_unavailable',
    } : {
      ...response.model_execution, requested_provider: 'google', requested_model: GOOGLE_ROUTER_MODEL,
    },
  };
}

/**
 * One response policy across delivery surfaces. Callers still own authorization,
 * durable reservations/checkpoints, cost scope and delivery. A turn snapshots its
 * policy; neither rollback nor failure restarts an action on another provider.
 */
export function responseClient(client: ResponseClient, surface: Surface, hooks?: {
  fallbackOptions?: (options?: ProcessMessageOptions) => Promise<{
    tools: Parameters<AddieClaudeClient['processMessage']>[2]; options: ProcessMessageOptions;
  }>;
  onFailure?: (reason: string, executions: AddieResponse['tool_executions']) => void;
}): Pick<AddieClaudeClient, 'processMessage' | 'processMessageStream'> {
  const policy = getResponseProviderPolicy();
  const sonnetOptions = (options?: ProcessMessageOptions): ProcessMessageOptions => ({
    ...options, modelOverride: AddieModelConfig.chat, directToolSession: undefined,
  });
  const candidate = () => {
    if (!process.env.GEMINI_API_KEY || !client.forkForGeminiDirect) {
      throw new Error('Gemini response provider unavailable');
    }
    let fork = clients.get(client);
    if (!fork) {
      fork = client.forkForGeminiDirect(new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY));
      clients.set(client, fork);
    }
    return fork;
  };
  const directOptions = (
    tools: Parameters<AddieClaudeClient['processMessage']>[2],
    options: ProcessMessageOptions | undefined, reserve: () => void,
  ): ProcessMessageOptions => {
    // Routed surfaces retain their exact allowlist. This session does not add
    // discovery or widen a router's safe/anonymous/teaching capability boundary.
    const allowed = options?.allowedToolNames ?? [
      ...(client.getRegisteredTools?.() ?? []), ...(tools?.tools.map(tool => tool.name) ?? []),
    ];
    return {
      ...options, modelOverride: GOOGLE_ROUTER_MODEL, disableServerTools: true, allowedToolNames: allowed,
      directToolSession: options?.directToolSession ?? {
        visibleToolNames: () => new Set(allowed),
        selectedToolSetNames: () => [...(options?.selectedToolSetNames ?? [])],
      },
      ...(options?.reserveSideEffect && { reserveSideEffect: async request => {
        reserve(); // Before awaiting: a failed write can have an uncertain outcome.
        await options.reserveSideEffect!(request);
      } }),
    };
  };
  const failed = (actionReserved: boolean, executions: AddieResponse['tool_executions']) => {
    const reason = actionReserved ? 'provider_error_after_action'
      : policy.automaticFallback ? 'provider_error' : 'automatic_fallback_disabled';
    hooks?.onFailure?.(reason, executions);
    logger.warn({ event: 'addie_response_provider_failure', surface, ...policy, reason,
      action_reserved: actionReserved }, 'Addie response provider failed');
    return !actionReserved && policy.automaticFallback;
  };
  const report = (response: AddieResponse) => {
    logger.info({ event: 'addie_response_provider', surface, ...policy,
      model_execution: response.model_execution }, 'Addie response provider completed');
    return response;
  };
  return {
    async processMessage(message, history, tools, rules, options) {
      if (policy.provider === 'sonnet') {
        return report(await client.processMessage!(message, history, tools, rules, sonnetOptions(options)));
      }
      let actionReserved = false;
      let response: AddieResponse | undefined;
      try {
        response = await candidate().processMessage(message, history, tools, rules,
          directOptions(tools, options, () => { actionReserved = true; }));
        if (!isProviderFailure(response)) return report(response);
      } catch { /* Fail closed unless explicitly enabled before an action. */ }
      if (!failed(actionReserved, response?.tool_executions ?? [])) {
        throw new Error(actionReserved
          ? 'Gemini could not finish after an action reservation; recorded outcomes were preserved.'
          : 'Addie response provider unavailable');
      }
      const fallback = await hooks?.fallbackOptions?.(options);
      return report(fallbackResponse(await client.processMessage!(message, history, fallback?.tools ?? tools, rules,
        sonnetOptions(fallback?.options ?? options))));
    },
    async *processMessageStream(message, history, tools, options) {
      if (policy.provider === 'sonnet') {
        for await (const event of client.processMessageStream(message, history, tools, sonnetOptions(options))) {
          if (event.type === 'done') report(event.response);
          yield event;
        }
        return;
      }
      const buffered: StreamEvent[] = [];
      let actionReserved = false;
      let response: AddieResponse | undefined;
      let failedStream = false;
      let iterator: AsyncGenerator<StreamEvent> | undefined;
      try {
        try {
          iterator = candidate().processMessageStream(message, history, tools,
            directOptions(tools, options, () => { actionReserved = true; }));
        } catch { failedStream = true; }
        while (iterator) {
          let next: IteratorResult<StreamEvent>;
          try { next = await iterator.next(); }
          catch { failedStream = true; break; }
          if (next.done) break;
          const event = next.value;
          buffered.push(event);
          // Yield receipts before advancing the provider: consumer checkpoint
          // failure/return must close this generator without fallback.
          if (event.type === 'tool_start' || event.type === 'tool_end') yield event;
          if (event.type === 'done') response = event.response;
          if (event.type === 'error' || event.type === 'stream_error') failedStream = true;
        }
      } finally {
        await iterator?.return(undefined);
      }
      if (!failedStream && response && !isProviderFailure(response)) {
        report(response);
        for (const event of buffered) {
          if (event.type !== 'tool_start' && event.type !== 'tool_end') yield event;
        }
        return;
      }
      const executions = buffered.flatMap(event => event.type === 'tool_end' ? [event.execution] : []);
      if (!failed(actionReserved, executions)) {
        yield { type: 'stream_error', deltasBeforeError: 0, tool_executions: executions,
          certification_reserve_used: buffered.some(event => event.type === 'stream_error' && event.certification_reserve_used),
          reason: actionReserved
            ? 'Gemini could not finish after an action was reserved. Its recorded outcome was preserved; the action was not automatically repeated.'
            : 'Addie response provider unavailable. Please try again later.' };
        return;
      }
      const fallback = await hooks?.fallbackOptions?.(options);
      for await (const event of client.processMessageStream(message, history, fallback?.tools ?? tools,
        sonnetOptions(fallback?.options ?? options))) {
        yield event.type === 'done' ? { ...event, response: report(fallbackResponse(event.response)) } : event;
      }
    },
  };
}
