/**
 * Committee Document Indexer Job
 *
 * Periodically indexes Google Docs and other documents tracked by committees.
 * Detects content changes and generates AI summaries.
 *
 * Process:
 * 1. Find documents that need indexing (new or stale)
 * 2. Fetch content from Google Docs API
 * 3. Compute content hash to detect changes
 * 4. Log activity if content changed
 * 5. Generate/update document summary if needed
 */

import * as crypto from 'crypto';
import { logger } from '../../logger.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import {
  isGoogleDocsUrl,
  createGoogleDocsToolHandlers,
  GOOGLE_DOCS_ERROR_PREFIX,
  GOOGLE_DOCS_ACCESS_DENIED_PREFIX,
} from '../mcp/google-docs.js';
import { isLLMConfigured, complete } from '../../utils/llm.js';
import type { CommitteeDocument, DocumentIndexStatus } from '../../types.js';

const workingGroupDb = new WorkingGroupDatabase();

export interface DocumentIndexResult {
  documentsChecked: number;
  documentsChanged: number;
  documentsError: number;
  summariesGenerated: number;
}

/**
 * Compute SHA-256 hash of content for change detection
 */
function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Fetch content from a Google Doc
 */
async function fetchGoogleDocContent(url: string): Promise<{
  content: string;
  error?: string;
  status: DocumentIndexStatus;
}> {
  const handlers = createGoogleDocsToolHandlers();

  if (!handlers) {
    return {
      content: '',
      error: 'Google Docs API not configured',
      status: 'error',
    };
  }

  try {
    const result = await handlers.read_google_doc({ url });

    // Check for access denied
    if (result.startsWith(GOOGLE_DOCS_ACCESS_DENIED_PREFIX)) {
      return {
        content: '',
        error: result,
        status: 'access_denied',
      };
    }

    // Check for other errors
    if (result.startsWith(GOOGLE_DOCS_ERROR_PREFIX)) {
      return {
        content: '',
        error: result,
        status: 'error',
      };
    }

    // Strip the title/format header if present
    const contentMatch = result.match(/^\*\*[^*]+\*\*[^\n]*\n\n([\s\S]*)$/);
    const content = contentMatch ? contentMatch[1] : result;

    return {
      content,
      status: 'success',
    };
  } catch (error) {
    return {
      content: '',
      error: error instanceof Error ? error.message : 'Unknown error',
      status: 'error',
    };
  }
}

/**
 * Generate a summary of document content using Claude
 */
async function generateDocumentSummary(
  title: string,
  content: string,
  committeeContext?: string
): Promise<string> {
  if (!isLLMConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // Truncate content to avoid token limits
  const maxContentLength = 30000;
  const truncatedContent = content.length > maxContentLength
    ? content.substring(0, maxContentLength) + '\n\n[Content truncated...]'
    : content;

  const systemPrompt = `You are summarizing a document for a working group at AgenticAdvertising.org.
Generate a brief, informative summary (2-4 sentences) that captures the key points.
Focus on what the document covers and any important updates or decisions.
Be concise and factual.`;

  const userPrompt = `Document: "${title}"
${committeeContext ? `Committee context: ${committeeContext}\n` : ''}
Content:
${truncatedContent}

Write a brief summary (2-4 sentences) of this document.`;

  const result = await complete({
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 300,
    model: 'primary',
    operationName: 'document-summary',
  });

  return result.text || 'Unable to generate summary.';
}

/**
 * Generate a summary of what changed between document versions
 */
async function generateChangeSummary(
  title: string,
  oldContent: string,
  newContent: string
): Promise<string> {
  if (!isLLMConfigured()) {
    return 'Document content was updated.';
  }

  // Truncate content
  const maxLength = 15000;
  const truncatedOld = oldContent.length > maxLength
    ? oldContent.substring(0, maxLength) + '...'
    : oldContent;
  const truncatedNew = newContent.length > maxLength
    ? newContent.substring(0, maxLength) + '...'
    : newContent;

  const result = await complete({
    system: 'Summarize the key changes between the old and new versions of this document in 1-2 sentences. Focus on substantive changes, not formatting.',
    prompt: `Document: "${title}"\n\nOLD VERSION:\n${truncatedOld}\n\nNEW VERSION:\n${truncatedNew}\n\nWhat changed?`,
    maxTokens: 200,
    model: 'primary',
    operationName: 'document-change-summary',
  });

  return result.text || 'Document was updated.';
}

/**
 * Index a single document
 */
async function indexDocument(doc: CommitteeDocument): Promise<{
  changed: boolean;
  error?: string;
  summary?: string;
}> {
  // Only Google Docs are supported for now
  if (!isGoogleDocsUrl(doc.document_url)) {
    logger.debug({ documentId: doc.id, url: doc.document_url }, 'Skipping non-Google-Doc URL');
    return { changed: false };
  }

  // Fetch content
  const { content, error, status } = await fetchGoogleDocContent(doc.document_url);

  if (status !== 'success') {
    // Update status to reflect the error
    await workingGroupDb.updateDocumentIndex(
      doc.id,
      doc.content_hash || '',
      doc.last_content || '',
      status,
      error
    );
    return { changed: false, error };
  }

  // Handle empty content case - this shouldn't normally happen but protects against
  // edge cases where a document exists but has no readable content
  if (!content || content.trim().length === 0) {
    logger.warn({ documentId: doc.id, title: doc.title }, 'Document has empty content');
    await workingGroupDb.updateDocumentIndex(
      doc.id,
      doc.content_hash || '',
      doc.last_content || '',
      'success',
      undefined
    );
    return { changed: false };
  }

  // Compute hash to detect changes
  const newHash = computeContentHash(content);
  const hasChanged = newHash !== doc.content_hash;

  // Update the document index
  await workingGroupDb.updateDocumentIndex(
    doc.id,
    newHash,
    content,
    'success'
  );

  // If content changed, log activity and generate change summary
  if (hasChanged && doc.content_hash) {
    const changeSummary = await generateChangeSummary(
      doc.title,
      doc.last_content || '',
      content
    );

    await workingGroupDb.logDocumentActivity(
      doc.id,
      doc.working_group_id,
      'content_changed',
      doc.content_hash,
      newHash,
      changeSummary
    );

    logger.info({
      documentId: doc.id,
      title: doc.title,
      changeSummary,
    }, 'Document content changed');
  } else if (!doc.content_hash) {
    // First index
    await workingGroupDb.logDocumentActivity(
      doc.id,
      doc.working_group_id,
      'indexed'
    );
  }

  // Generate/update summary if needed
  let summary: string | undefined;
  const needsSummary = !doc.document_summary || hasChanged;

  if (needsSummary) {
    try {
      summary = await generateDocumentSummary(doc.title, content);
      await workingGroupDb.updateDocumentSummary(doc.id, summary);
    } catch (summaryError) {
      logger.warn({ err: summaryError, documentId: doc.id }, 'Failed to generate document summary');
    }
  }

  return { changed: hasChanged, summary };
}

/**
 * Run the document indexer job
 */
export async function runDocumentIndexerJob(options: {
  batchSize?: number;
} = {}): Promise<DocumentIndexResult> {
  const { batchSize = 20 } = options;

  logger.info({ batchSize }, 'Running committee document indexer job');

  const result: DocumentIndexResult = {
    documentsChecked: 0,
    documentsChanged: 0,
    documentsError: 0,
    summariesGenerated: 0,
  };

  try {
    // Get documents that need indexing
    const documents = await workingGroupDb.getDocumentsPendingIndex(batchSize);
    result.documentsChecked = documents.length;

    if (documents.length === 0) {
      logger.debug('No documents pending index');
      return result;
    }

    logger.info({ count: documents.length }, 'Processing documents for indexing');

    // Process each document
    for (const doc of documents) {
      try {
        const { changed, error, summary } = await indexDocument(doc);

        if (error) {
          result.documentsError++;
        } else if (changed) {
          result.documentsChanged++;
        }

        if (summary) {
          result.summariesGenerated++;
        }

        // Small delay between documents to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (docError) {
        logger.error({ err: docError, documentId: doc.id }, 'Failed to index document');
        result.documentsError++;
      }
    }

    logger.info(result, 'Committee document indexer job completed');
    return result;
  } catch (error) {
    logger.error({ err: error }, 'Committee document indexer job failed');
    throw error;
  }
}

/**
 * Force re-index a specific document
 */
export async function reindexDocument(documentId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const doc = await workingGroupDb.getDocumentById(documentId);
  if (!doc) {
    return { success: false, error: 'Document not found' };
  }

  try {
    await indexDocument(doc);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
