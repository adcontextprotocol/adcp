import type { StoredToolCall } from './stream-tool-checkpoints.js';

interface RegistrationMessage {
  role: string;
  content: string;
  delivery_status?: string;
  tool_calls?: readonly StoredToolCall[] | null;
}

/** Recognize a request to register, including named agents and multiline intake. */
export function requestsAgentRegistration(message: string): boolean {
  const target = /\b(?:agents?|seller_agent|registry|directory)\b/i.test(message);
  return target && message.split(/\r?\n/).some(line =>
    /(?:^|[—–]\s*)(?:please\s+)?(?:help\s+me\s+)?(?:proceed\s+with\s+)?(?:register(?:ing)?|save|add|set\s+up)\b/i.test(line.trim()),
  );
}

/**
 * Keep the small registration domain through an authorized web intake. Only
 * user requests and completed execution receipts establish/finish the flow;
 * retrieved text and assistant promises cannot. This selects tools, never
 * grants organization access or authorizes a write on the user's behalf.
 */
export function hasActiveAgentRegistration(
  message: string,
  history: readonly RegistrationMessage[],
): boolean {
  const cancelled = (text: string) => /^(?:please\s+)?(?:cancel|stop|never\s*mind|forget\s+(?:it|that)|do\s+not\s+register|don't\s+register)\b/i.test(text.trim());
  if (cancelled(message)) return false;
  if (requestsAgentRegistration(message)) return true;
  let userTurns = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const turn = history[index];
    if (turn.role === 'assistant' && turn.delivery_status !== 'interrupted'
      && turn.tool_calls?.some(call => call.name === 'save_agent'
        && call.is_error === false && (!call.result_status || call.result_status === 'ok'))) return false;
    if (turn.role !== 'user') continue;
    if (++userTurns > 8 || cancelled(turn.content)) return false;
    if (requestsAgentRegistration(turn.content)) return true;
  }
  return false;
}
