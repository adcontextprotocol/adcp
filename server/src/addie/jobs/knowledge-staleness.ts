/**
 * Knowledge Staleness Detection Job
 *
 * Periodically checks for stale org_knowledge entries and logs them.
 * Stale entries are those older than the source-specific threshold.
 */

import { OrgKnowledgeDatabase } from '../../db/org-knowledge-db.js';
import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'knowledge-staleness' });
const orgKnowledgeDb = new OrgKnowledgeDatabase();

export async function runKnowledgeStalenessJob(options: { limit?: number } = {}): Promise<{
  staleEntries: number;
}> {
  const { limit = 100 } = options;

  const staleKnowledge = await orgKnowledgeDb.findStaleKnowledge(limit);

  if (staleKnowledge.length > 0) {
    logger.info(
      { count: staleKnowledge.length },
      'Found stale org knowledge entries'
    );

    // Group by source for summary
    const bySource: Record<string, number> = {};
    for (const entry of staleKnowledge) {
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }

    logger.info({ bySource }, 'Stale knowledge by source');
  }

  return { staleEntries: staleKnowledge.length };
}
