import { performance } from 'node:perf_hooks';
import * as relationshipDb from '../../db/relationship-db.js';
import * as personEvents from '../../db/person-events-db.js';
import { createLogger } from '../../logger.js';
import { trackBackground } from '../../services/brand-enrichment.js';

const logger = createLogger('addie-web-relationship-analytics');

export interface RelationshipAnalyticsResult {
  outcome: 'completed' | 'failed';
  processingMs: number;
}

interface RelationshipAnalyticsDependencies {
  resolvePersonId: typeof relationshipDb.resolvePersonId;
  recordPersonMessage: typeof relationshipDb.recordPersonMessage;
  deriveSentiment: typeof relationshipDb.deriveSentiment;
  recordEvent: typeof personEvents.recordEvent;
  buildMessageReceivedData: typeof personEvents.buildMessageReceivedData;
  schedule: (callback: () => void) => void;
}

const defaultDependencies: RelationshipAnalyticsDependencies = {
  resolvePersonId: relationshipDb.resolvePersonId,
  recordPersonMessage: relationshipDb.recordPersonMessage,
  deriveSentiment: relationshipDb.deriveSentiment,
  recordEvent: personEvents.recordEvent,
  buildMessageReceivedData: personEvents.buildMessageReceivedData,
  schedule: setImmediate,
};

/**
 * Detach CRM/engagement analytics from model admission. The returned promise
 * is observability-only: callers must not await it on the response path.
 */
export function scheduleWebRelationshipAnalytics(
  input: { userId: string; sanitizedMessage: string; source: 'web_chat' | 'web_chat_stream' },
  dependencies: RelationshipAnalyticsDependencies = defaultDependencies,
): { scheduleMs: number; completion: Promise<RelationshipAnalyticsResult> } {
  const scheduleStartedAt = performance.now();
  let begin!: () => void;
  const scheduled = new Promise<void>((resolve) => { begin = resolve; });
  dependencies.schedule(begin);
  const completion = scheduled.then(async (): Promise<RelationshipAnalyticsResult> => {
    const processingStartedAt = performance.now();
    try {
      const personId = await dependencies.resolvePersonId({ workos_user_id: input.userId });
      await dependencies.recordPersonMessage(personId, 'web');
      await dependencies.deriveSentiment(personId);
      await dependencies.recordEvent(personId, 'message_received', {
        channel: 'web',
        data: dependencies.buildMessageReceivedData(input.sanitizedMessage, input.source),
      });
      const result = { outcome: 'completed' as const, processingMs: Math.round(performance.now() - processingStartedAt) };
      logger.info({ event: 'addie_relationship_analytics_completed', duration_ms: result.processingMs }, 'Deferred web relationship analytics completed');
      return result;
    } catch (error) {
      const result = { outcome: 'failed' as const, processingMs: Math.round(performance.now() - processingStartedAt) };
      logger.warn({ event: 'addie_relationship_analytics_failed', duration_ms: result.processingMs, error }, 'Deferred web relationship analytics failed');
      return result;
    }
  });
  trackBackground(completion);

  const scheduleMs = Math.round(performance.now() - scheduleStartedAt);
  logger.debug({ event: 'addie_relationship_analytics_scheduled', duration_ms: scheduleMs }, 'Deferred web relationship analytics scheduled');
  return { scheduleMs, completion };
}
