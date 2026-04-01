/**
 * Google Docs Integration for Addie
 *
 * Allows Addie to read Google Docs shared with her Google account.
 * Uses OAuth2 with a refresh token for authentication.
 */

import { logger } from '../../logger.js';
import { ToolError } from '../tool-error.js';
import type { AddieTool } from '../types.js';

// Addie's email for access requests
const ADDIE_EMAIL = 'addie@agenticadvertising.org';

// Error prefixes for reliable error detection
export const GOOGLE_DOCS_ERROR_PREFIX = 'Error:';
export const GOOGLE_DOCS_ACCESS_DENIED_PREFIX = "I don't have access";

// Maximum content size (500KB)
const MAX_CONTENT_SIZE = 500 * 1024;

// Timeout for API requests (30 seconds)
const API_TIMEOUT_MS = 30000;

// Timeout for auth requests (10 seconds)
const AUTH_TIMEOUT_MS = 10000;

/**
 * Google OAuth2 configuration
 */
interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Token cache with mutex to prevent concurrent refresh races
 */
class GoogleAuthManager {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(private config: GoogleAuthConfig) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && now < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    // Prevent concurrent refresh requests - if one is in flight, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string> {
    const now = Date.now();

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Parse error but only log the error type, not full response (may contain tokens)
      let errorType = 'unknown';
      try {
        const errorText = await response.text();
        const parsed = JSON.parse(errorText);
        errorType = parsed.error || parsed.error_description || 'unknown';
      } catch {
        // Ignore parse errors
      }
      logger.error({ errorType, status: response.status }, 'Google OAuth: Failed to refresh token');
      throw new Error(`Failed to refresh Google access token: ${response.status} - ${errorType}`);
    }

    const data = await response.json() as { access_token: string; expires_in?: number };
    this.accessToken = data.access_token;
    // Tokens typically expire in 3600 seconds (1 hour)
    this.tokenExpiry = now + (data.expires_in || 3600) * 1000;

    logger.debug('Google OAuth: Refreshed access token');
    return data.access_token;
  }
}

// Singleton auth manager (created on first use)
let authManager: GoogleAuthManager | null = null;

function getAuthManager(config: GoogleAuthConfig): GoogleAuthManager {
  if (!authManager) {
    authManager = new GoogleAuthManager(config);
  }
  return authManager;
}

// Google Doc IDs are typically 44 characters of base64-ish characters
// Minimum length of ~10 chars for valid IDs
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]{10,}$/;

/**
 * Validate a Google Doc ID format
 */
function isValidDocId(id: string): boolean {
  return DOC_ID_REGEX.test(id);
}

/**
 * Check if a URL points to a Google Docs document (not a Drive file, Sheet, etc.)
 */
function isGoogleDocUrl(urlOrId: string): boolean {
  try {
    const url = new URL(urlOrId);
    return url.hostname === 'docs.google.com' && url.pathname.includes('/document/d/');
  } catch {
    return false;
  }
}

/**
 * Check if a URL points to a Google Sheets spreadsheet
 */
function isGoogleSheetsUrl(urlOrId: string): boolean {
  try {
    const url = new URL(urlOrId);
    return url.hostname === 'docs.google.com' && url.pathname.includes('/spreadsheets/d/');
  } catch {
    return false;
  }
}

/**
 * Extract plain text from a Google Docs API document response
 */
function extractTextFromDocsResponse(doc: {
  title?: string;
  body?: { content?: Array<{
    paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
  }> };
}): string {
  const parts: string[] = [];
  for (const item of doc.body?.content ?? []) {
    for (const elem of item.paragraph?.elements ?? []) {
      const text = elem.textRun?.content;
      if (text) parts.push(text);
    }
  }
  return parts.join('');
}

/**
 * Read a Google Doc using the Docs API (docs.googleapis.com).
 * This works even when the Drive API is restricted.
 */
async function readViaDocsApi(
  docId: string,
  accessToken: string,
): Promise<string | null> {
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    logger.debug({ status: response.status, docId }, 'Google Docs API: request failed, will try Drive API');
    return null;
  }

  const doc = await response.json() as {
    title?: string;
    body?: { content?: Array<{
      paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
    }> };
  };

  const title = doc.title || 'Untitled';
  const text = extractTextFromDocsResponse(doc);

  if (!text.trim()) {
    return `**${title}**\n\n(Document is empty)`;
  }

  if (text.length > MAX_CONTENT_SIZE) {
    return `**${title}**\n\n${text.substring(0, MAX_CONTENT_SIZE)}\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]`;
  }

  return `**${title}**\n\n${text}`;
}

/**
 * Read a Google Sheet using the Sheets API (sheets.googleapis.com).
 * Returns the sheet data as CSV text.
 * Requires the spreadsheets.readonly scope and the Sheets API enabled in the GCP project.
 */
async function readViaSheetsApi(
  spreadsheetId: string,
  accessToken: string,
): Promise<string | null> {
  // Get spreadsheet metadata and first sheet name
  const metaResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties.title`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );

  if (!metaResponse.ok) {
    logger.debug({ status: metaResponse.status, spreadsheetId }, 'Google Sheets API: metadata request failed, will try Drive API');
    return null;
  }

  const meta = await metaResponse.json() as {
    properties?: { title?: string };
    sheets?: Array<{ properties?: { title?: string } }>;
  };

  const title = meta.properties?.title || 'Untitled Spreadsheet';
  const sheetNames = (meta.sheets ?? []).map(s => s.properties?.title).filter(Boolean) as string[];

  if (sheetNames.length === 0) {
    return `**${title}**\n\n(Spreadsheet has no sheets)`;
  }

  // Read all values from the first sheet
  const firstSheet = sheetNames[0];
  const valuesResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(firstSheet)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );

  if (!valuesResponse.ok) {
    logger.debug({ status: valuesResponse.status, spreadsheetId }, 'Google Sheets API: values request failed');
    return null;
  }

  const valuesData = await valuesResponse.json() as {
    values?: string[][];
  };

  const rows = valuesData.values ?? [];
  if (rows.length === 0) {
    return `**${title}**\n\n(Sheet "${firstSheet}" is empty)`;
  }

  // Convert to CSV
  const csv = rows
    .map(row => row.map(cell => {
      const str = String(cell ?? '');
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(','))
    .join('\n');

  const sheetInfo = sheetNames.length > 1
    ? `\n\n(Showing sheet "${firstSheet}" — ${sheetNames.length} sheets total: ${sheetNames.join(', ')})`
    : '';

  if (csv.length > MAX_CONTENT_SIZE) {
    return `**${title}** (csv)\n\n${csv.substring(0, MAX_CONTENT_SIZE)}\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]${sheetInfo}`;
  }

  return `**${title}** (csv)\n\n${csv}${sheetInfo}`;
}

/**
 * Extract Google Doc/Drive ID from various URL formats
 *
 * Supports:
 * - https://docs.google.com/document/d/DOC_ID/edit
 * - https://drive.google.com/file/d/FILE_ID/view
 * - https://drive.google.com/open?id=FILE_ID
 * - Just the raw ID
 */
function extractDocId(urlOrId: string): string | null {
  // Already just an ID (no slashes or dots indicating URL)
  if (!urlOrId.includes('/') && !urlOrId.includes('.')) {
    return isValidDocId(urlOrId) ? urlOrId : null;
  }

  try {
    const url = new URL(urlOrId);

    // docs.google.com/document/d/ID/...
    const docMatch = url.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (docMatch && isValidDocId(docMatch[1])) return docMatch[1];

    // drive.google.com/file/d/ID/...
    const driveMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch && isValidDocId(driveMatch[1])) return driveMatch[1];

    // drive.google.com/open?id=ID
    const idParam = url.searchParams.get('id');
    if (idParam && isValidDocId(idParam)) return idParam;

    // docs.google.com/spreadsheets/d/ID/... (bonus: also works for sheets)
    const sheetsMatch = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetsMatch && isValidDocId(sheetsMatch[1])) return sheetsMatch[1];

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect if a URL is a Google Docs/Drive URL
 */
export function isGoogleDocsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'docs.google.com' ||
      parsed.hostname === 'drive.google.com'
    );
  } catch {
    return false;
  }
}

/**
 * Read a Google Doc as plain text
 */
async function readGoogleDoc(
  urlOrId: string,
  config: GoogleAuthConfig
): Promise<string> {
  const docId = extractDocId(urlOrId);
  if (!docId) {
    throw new ToolError(`Could not extract document ID from "${urlOrId}". Please provide a valid Google Docs or Google Drive URL.`);
  }

  try {
    const auth = getAuthManager(config);
    const accessToken = await auth.getAccessToken();

    // Try direct APIs first (Docs, Sheets) before Drive API.
    // These use sensitive scopes (documents.readonly, spreadsheets.readonly) that work
    // even when the restricted drive.readonly scope is silently blocked by Google
    // for unverified OAuth apps.
    if (isGoogleDocUrl(urlOrId)) {
      const docsResult = await readViaDocsApi(docId, accessToken);
      if (docsResult !== null) {
        return docsResult;
      }
    } else if (isGoogleSheetsUrl(urlOrId)) {
      const sheetsResult = await readViaSheetsApi(docId, accessToken);
      if (sheetsResult !== null) {
        return sheetsResult;
      }
    }

    // Fall through to Drive API for Drive file links, raw IDs, or if direct APIs failed
    const metadataResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}?fields=name,mimeType,capabilities`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }
    );

    if (!metadataResponse.ok) {
      if (metadataResponse.status === 404 || metadataResponse.status === 403) {
        // Drive API may be blocked for unverified OAuth apps. Try direct APIs
        // as a fallback before telling the user we can't access the document.
        logger.debug({ status: metadataResponse.status, docId }, 'Google Docs: Drive API inaccessible, trying direct APIs');
        const docsResult = await readViaDocsApi(docId, accessToken);
        if (docsResult !== null) return docsResult;
        const sheetsResult = await readViaSheetsApi(docId, accessToken);
        if (sheetsResult !== null) return sheetsResult;

        logger.warn({ status: metadataResponse.status, docId }, 'Google Docs: document inaccessible via all APIs');
        return `I don't have access to this document. Please share it with ${ADDIE_EMAIL} (Viewer access is fine) and let me know when you've done that.`;
      }
      const error = await metadataResponse.text();
      logger.error({ error, status: metadataResponse.status, docId }, 'Google Docs: Failed to get metadata');
      throw new ToolError(`Failed to access document (${metadataResponse.status})`);
    }

    const metadata = await metadataResponse.json() as { name: string; mimeType: string };
    const { name, mimeType } = metadata;

    logger.debug({ docId, name, mimeType }, 'Google Docs: Retrieved metadata');

    // Handle different file types
    let exportMimeType = 'text/plain';
    let exportFormat = 'text';

    if (mimeType === 'application/vnd.google-apps.document') {
      // Google Doc - export as plain text
      exportMimeType = 'text/plain';
      exportFormat = 'txt';
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Google Sheet - export as CSV
      exportMimeType = 'text/csv';
      exportFormat = 'csv';
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      // Google Slides - export as plain text
      exportMimeType = 'text/plain';
      exportFormat = 'txt';
    } else if (mimeType === 'application/pdf') {
      return `This is a PDF file (${name}). I cannot read PDF content directly. If you need me to understand the content, please copy and paste the relevant text.`;
    } else if (mimeType?.startsWith('image/')) {
      return `This is an image file (${name}). I can see it was shared but cannot view image contents directly.`;
    } else if (mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'application/json') {
      // Direct download for text files
      const downloadResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${docId}?alt=media`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        }
      );

      if (!downloadResponse.ok) {
        throw new ToolError(`Failed to download file (${downloadResponse.status})`);
      }

      const content = await downloadResponse.text();
      if (content.length > MAX_CONTENT_SIZE) {
        return `**${name}**\n\n${content.substring(0, MAX_CONTENT_SIZE)}\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]`;
      }
      return `**${name}**\n\n${content}`;
    } else {
      return `This is a ${mimeType || 'binary'} file (${name}). I cannot read the contents of this file type directly.`;
    }

    // Export Google Workspace files
    const exportResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }
    );

    if (!exportResponse.ok) {
      if (exportResponse.status === 404 || exportResponse.status === 403) {
        logger.warn({ status: exportResponse.status, docId }, 'Google Docs: export inaccessible');
        return `I don't have access to this document. Please share it with ${ADDIE_EMAIL} (Viewer access is fine) and let me know when you've done that.`;
      }
      const error = await exportResponse.text();
      logger.error({ error, status: exportResponse.status, docId }, 'Google Docs: Failed to export');
      throw new ToolError(`Failed to export document (${exportResponse.status})`);
    }

    const content = await exportResponse.text();

    if (content.length > MAX_CONTENT_SIZE) {
      return `**${name}** (${exportFormat})\n\n${content.substring(0, MAX_CONTENT_SIZE)}\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]`;
    }

    return `**${name}** (${exportFormat})\n\n${content}`;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    logger.error({ error, docId }, 'Google Docs: Unexpected error');
    if (error instanceof Error) {
      throw new ToolError(error.message);
    }
    throw new ToolError('Unknown error reading Google Doc');
  }
}

/**
 * Tool definition for reading Google Docs
 */
export const GOOGLE_DOCS_TOOLS: AddieTool[] = [
  {
    name: 'read_google_doc',
    description: `Read a Google Doc, Sheet, or file from Google Drive. Use this when a user shares a Google Docs or Google Drive link. If access is denied, Addie will ask the user to share the document with ${ADDIE_EMAIL}.`,
    usage_hints: 'use when user shares a docs.google.com or drive.google.com link',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The Google Docs or Google Drive URL, or the document ID',
        },
      },
      required: ['url'],
    },
  },
];

// Track if we've already logged the missing credentials warning
let credentialsWarningLogged = false;

/**
 * Create tool handlers for Google Docs
 * Returns null if Google credentials are not configured
 */
export function createGoogleDocsToolHandlers(): Record<string, (input: Record<string, unknown>) => Promise<string>> | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    // Only log once to avoid spamming logs
    if (!credentialsWarningLogged) {
      logger.warn('Google Docs tools not available: missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN');
      credentialsWarningLogged = true;
    }
    return null;
  }

  const config: GoogleAuthConfig = { clientId, clientSecret, refreshToken };

  return {
    read_google_doc: async (input: Record<string, unknown>) => {
      const url = input.url;

      // Validate input
      if (typeof url !== 'string' || !url.trim()) {
        throw new ToolError('URL parameter is required and must be a non-empty string');
      }

      const docId = extractDocId(url);
      logger.info({ docId }, 'Addie: Reading Google Doc');

      const result = await readGoogleDoc(url, config);

      // Truncate if too long
      if (result.length > 15000) {
        return result.substring(0, 15000) + '\n\n[Content truncated to 15,000 characters]';
      }

      return result;
    },
  };
}
