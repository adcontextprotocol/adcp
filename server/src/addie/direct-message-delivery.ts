import { createLogger } from '../logger.js';
import type { CreateMessageInput } from './thread-service.js';
import { getSlackApiErrorCode, isPermanentDmDeliveryError } from './slack-api-errors.js';

const logger = createLogger('addie-dm-delivery');

export interface DirectMessageDeliveryDependencies {
  postMessage: () => Promise<{ ts?: string }>;
  addMessage: (input: CreateMessageInput) => Promise<unknown>;
  flagThread: (threadId: string, reason: string) => Promise<unknown>;
}

export interface DirectMessageDeliveryInput {
  channelId: string;
  userId: string;
  threadId: string;
  assistantMessage: CreateMessageInput;
  userMessageFlagged: boolean;
  assistantFlagged: boolean;
  flagReason: string;
  dependencies: DirectMessageDeliveryDependencies;
}

export interface DirectMessageDeliveryResult {
  delivered: boolean;
  responseTs?: string;
  errorCode: string | null;
  permanentFailure: boolean;
}

/**
 * Deliver a prepared DM response and keep persistence aligned with what the
 * user actually saw. Failed deliveries retain tool executions as an internal
 * assistant marker so later turns know not to repeat completed mutations.
 */
export async function deliverAndRecordDirectMessage(
  input: DirectMessageDeliveryInput,
): Promise<DirectMessageDeliveryResult> {
  const { dependencies } = input;
  let delivered = false;
  let responseTs: string | undefined;
  let errorCode: string | null = null;
  let permanentFailure = false;

  try {
    const result = await dependencies.postMessage();
    responseTs = result.ts;
    delivered = true;
  } catch (error) {
    errorCode = getSlackApiErrorCode(error);
    permanentFailure = isPermanentDmDeliveryError(error);
    if (permanentFailure) {
      logger.warn(
        { slackError: errorCode, channelId: input.channelId, userId: input.userId },
        'Addie Bolt: DM channel does not allow responses',
      );
    } else {
      logger.error({ error }, 'Addie Bolt: Failed to send DM response');
    }
  }

  if (delivered) {
    try {
      await dependencies.addMessage(input.assistantMessage);
    } catch (error) {
      logger.error({ error, threadId: input.threadId }, 'Addie Bolt: Failed to save assistant message');
    }
  } else if (input.assistantMessage.tool_calls?.length) {
    const deliveryLabel = errorCode ?? 'unknown_error';
    try {
      await dependencies.addMessage({
        ...input.assistantMessage,
        role: 'assistant',
        content: `[Internal delivery note: Slack delivery failed (${deliveryLabel}). The recorded tool executions completed, but the user did not receive the assistant response. Do not repeat successful actions unless the user explicitly asks.]`,
        content_sanitized: undefined,
        flagged: true,
        flag_reason: `Slack delivery failed: ${deliveryLabel}`,
      });
    } catch (error) {
      logger.error({ error, threadId: input.threadId }, 'Addie Bolt: Failed to save undelivered tool audit');
    }
  }

  const hasUndeliveredToolAudit = !delivered && !!input.assistantMessage.tool_calls?.length;
  if (input.userMessageFlagged || (delivered && input.assistantFlagged) || hasUndeliveredToolAudit) {
    try {
      const threadFlagReason = [
        input.userMessageFlagged || (delivered && input.assistantFlagged) ? input.flagReason : undefined,
        hasUndeliveredToolAudit ? `Slack delivery failed: ${errorCode ?? 'unknown_error'}` : undefined,
      ].filter(Boolean).join('; ');
      await dependencies.flagThread(input.threadId, threadFlagReason);
    } catch (error) {
      logger.error({ error, threadId: input.threadId }, 'Addie Bolt: Failed to flag thread');
    }
  }

  if (delivered) {
    logger.info(
      { userId: input.userId, channelId: input.channelId, responseTs },
      'Addie Bolt: DM response sent',
    );
  }

  return { delivered, responseTs, errorCode, permanentFailure };
}
