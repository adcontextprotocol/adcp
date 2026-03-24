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
import { PDFParse } from 'pdf-parse';
import yauzl from 'yauzl';
import { refreshWorkingGroupDocs } from '../mcp/docs-indexer.js';
import type { CommitteeDocument, DocumentIndexStatus } from '../../types.js';

interface ExtractedAsset {
  filename: string;
  mimeType: string;
  data: Buffer;
  width?: number;
  height?: number;
  pageNumber?: number;
}

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

const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024; // 100 MB

// Only these image types are safe to serve and supported by Claude vision
const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Fetch a document from a URL and return the raw buffer.
 * Enforces a size limit and disables redirect following to prevent SSRF.
 */
async function fetchDocumentBuffer(url: string): Promise<{
  buffer: Buffer;
  error?: string;
  status: DocumentIndexStatus;
}> {
  try {
    const response = await fetch(url, { redirect: 'error' });

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        return { buffer: Buffer.alloc(0), error: `Access denied (HTTP ${response.status})`, status: 'access_denied' };
      }
      return { buffer: Buffer.alloc(0), error: `HTTP ${response.status}: ${response.statusText}`, status: 'error' };
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_DOCUMENT_SIZE) {
      return { buffer: Buffer.alloc(0), error: `File too large (${contentLength} bytes)`, status: 'error' };
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOCUMENT_SIZE) {
      return { buffer: Buffer.alloc(0), error: `File too large (${arrayBuffer.byteLength} bytes)`, status: 'error' };
    }

    return { buffer: Buffer.from(arrayBuffer), status: 'success' };
  } catch (error) {
    return { buffer: Buffer.alloc(0), error: error instanceof Error ? error.message : 'Fetch failed', status: 'error' };
  }
}

/**
 * Extract text and images from a PDF buffer
 */
async function parsePdfContent(buffer: Buffer): Promise<{
  content: string;
  assets: ExtractedAsset[];
  error?: string;
  status: DocumentIndexStatus;
}> {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    // Extract text
    const textResult = await parser.getText();
    const content = textResult.text?.trim() || '';

    // Extract images (skip tiny images like bullets/icons)
    const assets: ExtractedAsset[] = [];
    try {
      const imageResult = await parser.getImage({ imageBuffer: true, imageThreshold: 50 });
      for (const page of imageResult.pages) {
        for (const img of page.images) {
          if (!img.data || img.data.length < 1000) continue; // Skip tiny images
          const mimeType = guessMimeFromImageKind(img.kind);
          assets.push({
            filename: `page${page.pageNumber}_${img.name || assets.length}.png`,
            mimeType,
            data: Buffer.from(img.data),
            width: img.width,
            height: img.height,
            pageNumber: page.pageNumber,
          });
        }
      }
    } catch (imgErr) {
      logger.warn({ err: imgErr }, 'Failed to extract images from PDF');
    }

    await parser.destroy();

    if (!content && assets.length === 0) {
      return { content: '', assets: [], error: 'PDF contained no extractable content', status: 'error' };
    }

    return { content, assets, status: 'success' };
  } catch (error) {
    return {
      content: '',
      assets: [],
      error: error instanceof Error ? error.message : 'Failed to parse PDF',
      status: 'error',
    };
  }
}

function guessMimeFromImageKind(_kind: number | string): string {
  // pdf-parse extracts raw pixel data regardless of ImageKind — always PNG
  return 'image/png';
}

/**
 * Extract text and images from a PPTX buffer (ZIP of XML + media)
 */
async function parsePptxContent(buffer: Buffer): Promise<{
  content: string;
  assets: ExtractedAsset[];
  error?: string;
  status: DocumentIndexStatus;
}> {
  return new Promise((resolve) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve({ content: '', assets: [], error: err?.message || 'Failed to open PPTX', status: 'error' });
        return;
      }

      const slideTexts = new Map<number, string>();
      const assets: ExtractedAsset[] = [];
      const pendingEntries: Array<Promise<void>> = [];
      let totalDecompressedBytes = 0;
      let aborted = false;

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        if (aborted) return;
        const filename: string = entry.fileName;

        // Extract text from slide XML files
        const slideMatch = filename.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        // Extract images from media folder
        const mediaMatch = filename.match(/^ppt\/media\/(.+)$/);

        if (slideMatch || mediaMatch) {
          const p = new Promise<void>((entryResolve) => {
            zipfile.openReadStream(entry, (streamErr, stream) => {
              if (streamErr || !stream) {
                entryResolve();
                return;
              }

              const chunks: Buffer[] = [];
              stream.on('data', (chunk: Buffer) => {
                totalDecompressedBytes += chunk.length;
                if (totalDecompressedBytes > MAX_DECOMPRESSED_SIZE) {
                  aborted = true;
                  stream.destroy();
                  zipfile.close();
                  return;
                }
                chunks.push(chunk);
              });
              stream.on('end', () => {
                if (aborted) { entryResolve(); return; }
                const data = Buffer.concat(chunks);

                if (slideMatch) {
                  const slideNum = parseInt(slideMatch[1], 10);
                  const text = extractTextFromSlideXml(data.toString('utf-8'));
                  if (text) slideTexts.set(slideNum, text);
                } else if (mediaMatch) {
                  const mediaName = mediaMatch[1];
                  const mimeType = guessMimeFromFilename(mediaName);
                  if (SAFE_IMAGE_TYPES.has(mimeType) && data.length > 1000) {
                    assets.push({
                      filename: mediaName,
                      mimeType,
                      data,
                    });
                  }
                }

                entryResolve();
              });
            });
          });
          pendingEntries.push(p);
        }

        zipfile.readEntry();
      });

      zipfile.on('end', async () => {
        await Promise.all(pendingEntries);

        if (aborted) {
          resolve({ content: '', assets: [], error: 'Decompressed content exceeds size limit', status: 'error' });
          return;
        }

        // Combine slide texts in order
        const sortedSlides = [...slideTexts.entries()].sort(([a], [b]) => a - b);
        const content = sortedSlides.map(([, text]) => text).join('\n\n');

        resolve({ content, assets, status: 'success' });
      });

      zipfile.on('error', (zipErr) => {
        resolve({ content: '', assets: [], error: zipErr.message, status: 'error' });
      });
    });
  });
}

/**
 * Extract readable text from a PPTX slide XML string
 */
function extractTextFromSlideXml(xml: string): string {
  // PPTX slide text lives in <a:t> tags
  const textParts: string[] = [];
  const regex = /<a:t>([^<]*)<\/a:t>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    if (match[1].trim()) {
      textParts.push(match[1]);
    }
  }
  return textParts.join(' ').trim();
}

function guessMimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  // Only safe, serveable image types — no SVG (XSS risk), no exotic formats
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeMap[ext || ''] || '';
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
async function indexDocument(doc: CommitteeDocument & { has_file_data?: boolean }): Promise<{
  changed: boolean;
  error?: string;
  summary?: string;
}> {
  let content: string;
  let assets: ExtractedAsset[] = [];
  let error: string | undefined;
  let status: DocumentIndexStatus;

  if (doc.document_type === 'pdf' || doc.document_type === 'pptx') {
    // Get file buffer: from DB (uploaded) or from URL (linked)
    let buffer: Buffer;

    if (doc.has_file_data) {
      const fileData = await workingGroupDb.getDocumentFileData(doc.id, doc.working_group_id);
      if (!fileData) {
        await workingGroupDb.updateDocumentIndex(doc.id, doc.content_hash || '', doc.last_content || '', 'error', 'Uploaded file data missing');
        return { changed: false, error: 'Uploaded file data missing' };
      }
      buffer = fileData.file_data;
    } else if (doc.document_url) {
      const fetchResult = await fetchDocumentBuffer(doc.document_url);
      if (fetchResult.status !== 'success') {
        await workingGroupDb.updateDocumentIndex(doc.id, doc.content_hash || '', doc.last_content || '', fetchResult.status, fetchResult.error);
        return { changed: false, error: fetchResult.error };
      }
      buffer = fetchResult.buffer;
    } else {
      await workingGroupDb.updateDocumentIndex(doc.id, doc.content_hash || '', doc.last_content || '', 'error', 'No file data or URL');
      return { changed: false, error: 'No file data or URL' };
    }

    const parseResult = doc.document_type === 'pdf'
      ? await parsePdfContent(buffer)
      : await parsePptxContent(buffer);

    content = parseResult.content;
    assets = parseResult.assets;
    error = parseResult.error;
    status = parseResult.status;
  } else if (doc.document_url && isGoogleDocsUrl(doc.document_url)) {
    const fetchResult = await fetchGoogleDocContent(doc.document_url);
    content = fetchResult.content;
    error = fetchResult.error;
    status = fetchResult.status;
  } else {
    logger.debug({ documentId: doc.id, url: doc.document_url }, 'Skipping unsupported document URL');
    return { changed: false };
  }

  if (status !== 'success') {
    await workingGroupDb.updateDocumentIndex(doc.id, doc.content_hash || '', doc.last_content || '', status, error);
    return { changed: false, error };
  }

  if ((!content || content.trim().length === 0) && assets.length === 0) {
    logger.warn({ documentId: doc.id, title: doc.title }, 'Document has empty content');
    await workingGroupDb.updateDocumentIndex(doc.id, doc.content_hash || '', doc.last_content || '', 'success');
    return { changed: false };
  }

  // Compute hash to detect changes
  const newHash = computeContentHash(content);
  const hasChanged = newHash !== doc.content_hash;

  // Update the document index
  await workingGroupDb.updateDocumentIndex(doc.id, newHash, content, 'success');

  // Store extracted assets if content changed
  if (hasChanged && assets.length > 0) {
    try {
      // Clear old assets and store new ones
      await workingGroupDb.deleteDocumentAssets(doc.id);
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        await workingGroupDb.createDocumentAsset({
          document_id: doc.id,
          working_group_id: doc.working_group_id,
          filename: asset.filename,
          mime_type: asset.mimeType,
          width: asset.width,
          height: asset.height,
          file_size: asset.data.length,
          asset_data: asset.data,
          page_number: asset.pageNumber,
          extraction_order: i,
        });
      }
      logger.info({ documentId: doc.id, assetCount: assets.length }, 'Stored extracted document assets');
    } catch (assetError) {
      logger.warn({ err: assetError, documentId: doc.id }, 'Failed to store document assets');
    }
  }

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

  logger.debug({ batchSize }, 'Running committee document indexer job');

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

    logger.debug({ count: documents.length }, 'Processing documents for indexing');

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

    // Refresh the in-memory search index if any documents changed
    if (result.documentsChanged > 0) {
      await refreshWorkingGroupDocs();
    }

    logger.debug(result, 'Committee document indexer job completed');
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

/**
 * Generate descriptions for extracted assets using Claude vision.
 * Runs as a separate pass after indexing so image descriptions
 * become searchable alongside document text.
 */
export async function generateAssetDescriptions(batchSize = 5): Promise<number> {
  if (!isLLMConfigured()) return 0;

  const assets = await workingGroupDb.getAssetsWithoutDescriptions(batchSize);
  let described = 0;

  for (const asset of assets) {
    if (!SAFE_IMAGE_TYPES.has(asset.mime_type)) continue;

    try {
      const base64 = asset.asset_data.toString('base64');
      const mediaType = asset.mime_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

      const result = await complete({
        system: 'Describe this image from a brand/design document. Focus on: what it shows (logo, color palette, typography, layout, photo), any text visible, colors used, and how it relates to brand identity. Be concise (1-3 sentences).',
        prompt: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: `Describe this image from the document "${asset.filename}".` },
        ],
        maxTokens: 200,
        model: 'primary',
        operationName: 'asset-description',
      });

      if (result.text) {
        await workingGroupDb.updateAssetDescription(asset.id, result.text);
        described++;
      }
    } catch (err) {
      logger.warn({ err, assetId: asset.id }, 'Failed to generate asset description');
    }
  }

  return described;
}
