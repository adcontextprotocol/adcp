/**
 * Scheduled refresh for Addie's in-memory docs search index.
 */

import {
  getDocCount,
  getHeadingCount,
  initializeDocsIndex,
} from '../mcp/docs-indexer.js';

export interface DocsIndexRefreshResult {
  docsIndexed: number;
  headingsIndexed: number;
}

export async function runDocsIndexRefreshJob(): Promise<DocsIndexRefreshResult> {
  await initializeDocsIndex();
  return {
    docsIndexed: getDocCount(),
    headingsIndexed: getHeadingCount(),
  };
}
