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
 * Subset of the Google Docs API document response we use for markdown
 * conversion. Full spec: https://developers.google.com/docs/api/reference/rest/v1/documents#Document
 */
interface GoogleDocsApiDocument {
  title?: string;
  body?: {
    content?: Array<{
      paragraph?: GoogleDocsApiParagraph;
      table?: GoogleDocsApiTable;
      // Other structural elements we explicitly handle or skip:
      //   sectionBreak, tableOfContents — silently skipped
      //   horizontalRule — mapped to `---`
      sectionBreak?: unknown;
      tableOfContents?: unknown;
      horizontalRule?: unknown;
    }>;
  };
  lists?: Record<string, { listProperties?: { nestingLevels?: Array<{ glyphType?: string }> } }>;
}

interface GoogleDocsApiParagraph {
  elements?: Array<{
    textRun?: {
      content?: string;
      textStyle?: {
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
        link?: { url?: string };
      };
    };
  }>;
  paragraphStyle?: {
    namedStyleType?: string;
  };
  bullet?: {
    listId?: string;
    nestingLevel?: number;
  };
}

interface GoogleDocsApiTable {
  rows?: number;
  columns?: number;
  tableRows?: Array<{
    tableCells?: Array<{
      content?: Array<{ paragraph?: GoogleDocsApiParagraph }>;
    }>;
  }>;
}

/**
 * Convert a Google Docs API document response into markdown.
 *
 * Preserves headings (HEADING_1-6, TITLE, SUBTITLE), inline formatting
 * (bold, italic, strikethrough, underline, links), bullet and numbered
 * lists (nested up to common depths), and tables (as GFM pipe tables).
 * Images and drawings are rendered as `![image]()` placeholders since the
 * Docs API doesn't expose stable CDN URLs.
 */
export function extractMarkdownFromDocsResponse(doc: GoogleDocsApiDocument): string {
  const lines: string[] = [];
  const content = doc.body?.content ?? [];
  const listsMeta = doc.lists ?? {};

  for (const item of content) {
    if (item.paragraph) {
      const rendered = renderParagraph(item.paragraph, listsMeta);
      if (rendered !== null) lines.push(rendered);
    } else if (item.table) {
      const rendered = renderTable(item.table, listsMeta);
      if (rendered) lines.push(rendered);
    } else if (item.horizontalRule) {
      lines.push('---');
    } else if (item.sectionBreak !== undefined || item.tableOfContents !== undefined) {
      // Page breaks and TOCs don't translate to markdown; skip silently.
    } else {
      // Unknown node — log for visibility but don't fail.
      logger.debug({ keys: Object.keys(item) }, 'Google Docs: unhandled content node');
    }
  }

  // Collapse runs of 3+ newlines into double-newline so markdown stays clean.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render a single paragraph to markdown. Returns null for empty paragraphs
 * so the caller can skip them without inflating blank lines.
 */
function renderParagraph(
  paragraph: GoogleDocsApiParagraph,
  listsMeta: NonNullable<GoogleDocsApiDocument['lists']>,
): string | null {
  const inline = paragraph.elements
    ?.map(e => renderTextRun(e.textRun))
    .filter((s): s is string => s !== null)
    .join('') ?? '';

  // Drop the trailing newline Google puts on every paragraph.
  const text = inline.replace(/\n+$/, '');
  if (!text && !paragraph.bullet) return '';

  const style = paragraph.paragraphStyle?.namedStyleType;
  const headingPrefix = headingPrefixFor(style);
  if (headingPrefix) return `${headingPrefix} ${text}`;

  if (paragraph.bullet) {
    const nestingLevel = paragraph.bullet.nestingLevel ?? 0;
    const indent = '  '.repeat(nestingLevel);
    const listId = paragraph.bullet.listId;
    const glyph = listId && listsMeta[listId]?.listProperties?.nestingLevels?.[nestingLevel]?.glyphType;
    // Glyph types starting with "DECIMAL", "UPPER_ALPHA", etc. indicate an ordered list.
    const isOrdered = typeof glyph === 'string' &&
      /^(DECIMAL|UPPER_ALPHA|LOWER_ALPHA|UPPER_ROMAN|LOWER_ROMAN)/.test(glyph);
    const marker = isOrdered ? '1.' : '-';
    return `${indent}${marker} ${text}`;
  }

  return text;
}

function headingPrefixFor(style: string | undefined): string | null {
  switch (style) {
    case 'TITLE': return '#';
    case 'SUBTITLE': return '##';
    case 'HEADING_1': return '#';
    case 'HEADING_2': return '##';
    case 'HEADING_3': return '###';
    case 'HEADING_4': return '####';
    case 'HEADING_5': return '#####';
    case 'HEADING_6': return '######';
    default: return null;
  }
}

function renderTextRun(textRun: NonNullable<GoogleDocsApiParagraph['elements']>[number]['textRun']): string | null {
  if (!textRun?.content) return null;
  const raw = textRun.content;
  const style = textRun.textStyle ?? {};

  // Skip wrapping purely-whitespace runs so we don't emit `** **` or
  // swallow inter-word spacing. Returning the raw run preserves the
  // whitespace between adjacent styled runs.
  if (!raw.trim()) return raw;

  // Preserve both leading AND trailing whitespace around the styled core.
  // Google often emits a run like " bold" (leading space, bolded); if we
  // only restored trailing whitespace, `"hello" + " bold"` would render
  // as `hello**bold**` with no space between words.
  // Note: `underline` is intentionally not mapped — markdown has no
  // native underline syntax.
  const leading = raw.match(/^\s+/)?.[0] ?? '';
  const trailing = raw.match(/\s+$/)?.[0] ?? '';
  let core = raw.trim();

  const link = style.link?.url;
  if (style.strikethrough) core = `~~${core}~~`;
  if (style.italic) core = `*${core}*`;
  if (style.bold) core = `**${core}**`;
  if (link) core = `[${core}](${link})`;

  return `${leading}${core}${trailing}`;
}

function renderTable(
  table: GoogleDocsApiTable,
  listsMeta: NonNullable<GoogleDocsApiDocument['lists']>,
): string {
  const rows = table.tableRows ?? [];
  if (rows.length === 0) return '';

  const cellText = (cell: NonNullable<NonNullable<GoogleDocsApiTable['tableRows']>[number]['tableCells']>[number]): string => {
    const paragraphs = cell.content ?? [];
    return paragraphs
      .map(p => p.paragraph ? renderParagraph(p.paragraph, listsMeta) ?? '' : '')
      .join(' ')
      // Escape backslashes *first*, then pipes. Otherwise an existing
      // literal `\|` in the cell (rare but possible in raw text content)
      // would become `\\|` — which GFM reads as "escaped backslash,
      // literal pipe" and breaks the cell out into a new column.
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\n+/g, ' ')
      .trim();
  };

  const matrix = rows.map(r => (r.tableCells ?? []).map(cellText));
  const columnCount = Math.max(...matrix.map(row => row.length));
  // Pad each row to the widest so the header separator lines up
  const padded = matrix.map(row => {
    while (row.length < columnCount) row.push('');
    return row;
  });

  if (padded.length === 0 || columnCount === 0) return '';

  const header = padded[0];
  const separator = new Array(columnCount).fill('---');
  const body = padded.slice(1);

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
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
    let errorDetail = '';
    try {
      const body = await response.json() as { error?: { message?: string; status?: string } };
      errorDetail = body.error?.message || body.error?.status || '';
    } catch { /* ignore parse errors */ }
    logger.warn({ status: response.status, docId, errorDetail }, 'Google Docs API: request failed, will try Drive API');
    return null;
  }

  const doc = await response.json() as GoogleDocsApiDocument;

  const title = doc.title || 'Untitled';
  const markdown = extractMarkdownFromDocsResponse(doc);

  if (!markdown.trim()) {
    return `# ${title}\n\n(Document is empty)`;
  }

  // If the document already has a title-style heading at the top, don't
  // double it with the file name.
  const body = markdown.startsWith('#') ? markdown : `# ${title}\n\n${markdown}`;

  if (body.length > MAX_CONTENT_SIZE) {
    return `${body.substring(0, MAX_CONTENT_SIZE)}\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]`;
  }

  return body;
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
    let errorDetail = '';
    try {
      const body = await metaResponse.json() as { error?: { message?: string; status?: string } };
      errorDetail = body.error?.message || body.error?.status || '';
    } catch { /* ignore parse errors */ }
    logger.warn({ status: metaResponse.status, spreadsheetId, errorDetail }, 'Google Sheets API: metadata request failed, will try Drive API');
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
 * Structured result shape returned by `readGoogleDocStructured`.
 *
 * Callers should branch on `status`, not sniff the text of `body` or
 * `message`. Natural-language sentinels (e.g. "I don't have access")
 * collide with legitimate document content (#2756) — the status field
 * is the only reliable signal.
 *
 * Introduced per #2754; replaces the previous stringly-typed return
 * and its companion prefix constants (GOOGLE_DOCS_ERROR_PREFIX /
 * GOOGLE_DOCS_ACCESS_DENIED_PREFIX, now removed).
 */
export interface GoogleDocResult {
  status: 'ok' | 'access_denied' | 'empty' | 'invalid_input' | 'unsupported_type' | 'error';
  title: string | null;
  /** Markdown (for Docs/Slides) or CSV (for Sheets). */
  body: string | null;
  /** The mime type reported by the Drive API, or null on early error. */
  mime_type: string | null;
  /** 'markdown' | 'csv' | 'text' — what `body` contains, or null. */
  format: 'markdown' | 'csv' | 'text' | null;
  /** Human-readable message for non-ok statuses. */
  message: string | null;
  /** True if `body` was cut at MAX_CONTENT_SIZE. */
  truncated: boolean;
}

/**
 * Read a Google Doc / Sheet / Drive file and return a structured result.
 *
 * Always returns a `GoogleDocResult` — does not throw for auth / not-found
 * conditions. Only throws (via `ToolError`) for unexpected internal
 * failures the caller can't handle meaningfully.
 */
async function readGoogleDocStructured(
  urlOrId: string,
  config: GoogleAuthConfig
): Promise<GoogleDocResult> {
  const docId = extractDocId(urlOrId);
  if (!docId) {
    return {
      status: 'invalid_input',
      title: null,
      body: null,
      mime_type: null,
      format: null,
      message: `Could not extract document ID from "${urlOrId}". Please provide a valid Google Docs or Google Drive URL.`,
      truncated: false,
    };
  }

  const accessDenied = (): GoogleDocResult => ({
    status: 'access_denied',
    title: null,
    body: null,
    mime_type: null,
    format: null,
    message: `I don't have access to this document. Please share it with ${ADDIE_EMAIL} (Viewer access is fine) and let me know when you've done that.`,
    truncated: false,
  });

  const okResult = (
    title: string,
    body: string,
    mimeType: string,
    format: 'markdown' | 'csv' | 'text',
  ): GoogleDocResult => {
    const truncated = body.length > MAX_CONTENT_SIZE;
    return {
      status: body.trim() ? 'ok' : 'empty',
      title,
      body: truncated ? body.substring(0, MAX_CONTENT_SIZE) : body,
      mime_type: mimeType,
      format,
      message: null,
      truncated,
    };
  };

  try {
    const auth = getAuthManager(config);
    const accessToken = await auth.getAccessToken();

    // Try direct APIs first (Docs, Sheets) before Drive API. These use
    // sensitive scopes (documents.readonly, spreadsheets.readonly) that
    // work even when the restricted drive.readonly scope is silently
    // blocked by Google for unverified OAuth apps.
    if (isGoogleDocUrl(urlOrId)) {
      const text = await readViaDocsApi(docId, accessToken);
      if (text !== null) {
        const { title, body } = splitHeadedString(text);
        return okResult(title, body, 'application/vnd.google-apps.document', 'markdown');
      }
    } else if (isGoogleSheetsUrl(urlOrId)) {
      const text = await readViaSheetsApi(docId, accessToken);
      if (text !== null) {
        const { title, body } = splitHeadedString(text);
        return okResult(title, body, 'application/vnd.google-apps.spreadsheet', 'csv');
      }
    }

    // Fall through to Drive API for Drive file links, raw IDs, or if
    // the direct APIs returned null (non-200).
    const metadataResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}?fields=name,mimeType,capabilities`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }
    );

    if (!metadataResponse.ok) {
      if (metadataResponse.status === 404 || metadataResponse.status === 403) {
        // Drive API may be blocked for unverified OAuth apps. Try direct
        // APIs as a last-ditch fallback before telling the user we can't
        // access the document.
        let driveError = '';
        try {
          const body = await metadataResponse.json() as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
          driveError = body.error?.message || body.error?.errors?.[0]?.reason || '';
        } catch { /* ignore parse errors */ }
        logger.warn({ status: metadataResponse.status, docId, driveError }, 'Google Docs: Drive API inaccessible, trying direct APIs');

        const docsText = await readViaDocsApi(docId, accessToken);
        if (docsText !== null) {
          const { title, body } = splitHeadedString(docsText);
          return okResult(title, body, 'application/vnd.google-apps.document', 'markdown');
        }
        const sheetsText = await readViaSheetsApi(docId, accessToken);
        if (sheetsText !== null) {
          const { title, body } = splitHeadedString(sheetsText);
          return okResult(title, body, 'application/vnd.google-apps.spreadsheet', 'csv');
        }

        logger.warn({ status: metadataResponse.status, docId, driveError }, 'Google Docs: document inaccessible via all APIs');
        return accessDenied();
      }
      const error = await metadataResponse.text();
      logger.error({ error, status: metadataResponse.status, docId }, 'Google Docs: Failed to get metadata');
      return {
        status: 'error',
        title: null,
        body: null,
        mime_type: null,
        format: null,
        message: `Failed to access document (HTTP ${metadataResponse.status})`,
        truncated: false,
      };
    }

    const metadata = await metadataResponse.json() as { name: string; mimeType: string };
    const { name, mimeType } = metadata;

    logger.debug({ docId, name, mimeType }, 'Google Docs: Retrieved metadata');

    // Non-exportable types: return unsupported_type with the mime so the
    // caller can decide what to do (Addie will ask the user to paste
    // instead). We don't attempt OCR / PDF extraction here.
    if (mimeType === 'application/pdf') {
      return {
        status: 'unsupported_type',
        title: name,
        body: null,
        mime_type: mimeType,
        format: null,
        message: `This is a PDF file. I cannot read PDF content directly — please copy the relevant text and paste it.`,
        truncated: false,
      };
    }
    if (mimeType?.startsWith('image/')) {
      return {
        status: 'unsupported_type',
        title: name,
        body: null,
        mime_type: mimeType,
        format: null,
        message: `This is an image file. I can see it was shared but cannot view image contents directly.`,
        truncated: false,
      };
    }
    if (mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'application/json') {
      // Direct download for raw text files
      const downloadResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${docId}?alt=media`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        }
      );

      if (!downloadResponse.ok) {
        return {
          status: 'error',
          title: name,
          body: null,
          mime_type: mimeType,
          format: null,
          message: `Failed to download file (HTTP ${downloadResponse.status})`,
          truncated: false,
        };
      }

      const content = await downloadResponse.text();
      const format = mimeType === 'text/markdown' ? 'markdown' : 'text';
      return okResult(name, content, mimeType, format);
    }

    // Google Workspace files — pick export mimeType and format.
    let exportMimeType: string;
    let format: 'markdown' | 'csv' | 'text';
    if (mimeType === 'application/vnd.google-apps.document') {
      exportMimeType = 'text/markdown';
      format = 'markdown';
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      exportMimeType = 'text/csv';
      format = 'csv';
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      exportMimeType = 'text/plain';
      format = 'text';
    } else {
      return {
        status: 'unsupported_type',
        title: name,
        body: null,
        mime_type: mimeType,
        format: null,
        message: `This is a ${mimeType || 'binary'} file. I cannot read the contents of this file type directly.`,
        truncated: false,
      };
    }

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
        return accessDenied();
      }
      const error = await exportResponse.text();
      logger.error({ error, status: exportResponse.status, docId }, 'Google Docs: Failed to export');
      return {
        status: 'error',
        title: name,
        body: null,
        mime_type: mimeType,
        format: null,
        message: `Failed to export document (HTTP ${exportResponse.status})`,
        truncated: false,
      };
    }

    const content = await exportResponse.text();
    return okResult(name, content, mimeType, format);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    logger.error({ error, docId }, 'Google Docs: Unexpected error');
    const message = error instanceof Error ? error.message : 'Unknown error reading Google Doc';
    return {
      status: 'error',
      title: null,
      body: null,
      mime_type: null,
      format: null,
      message,
      truncated: false,
    };
  }
}

/**
 * Parse a legacy `"# <Title>\n\n<body>"` or `"**<Name>**\n\n<body>"`
 * string (emitted by `readViaDocsApi` / `readViaSheetsApi`) back into
 * structured title + body. Used during the structured-result
 * transition — when those two helpers are updated to return structure
 * directly, this can go away.
 */
function splitHeadedString(text: string): { title: string; body: string } {
  // `# Title\n\n<rest>` (Docs API converter output, see
  // extractMarkdownFromDocsResponse)
  const h1 = text.match(/^#\s+(.+?)\n\n([\s\S]*)$/);
  if (h1) return { title: h1[1].trim(), body: h1[2] };
  // `**Title** (csv)\n\n<rest>` (readViaSheetsApi output)
  const bold = text.match(/^\*\*(.+?)\*\*(?:\s+\([^)]+\))?\n\n([\s\S]*)$/);
  if (bold) return { title: bold[1].trim(), body: bold[2] };
  return { title: 'Untitled', body: text };
}

/**
 * Legacy string-returning facade over `readGoogleDocStructured`.
 * Preserves the original API for internal callers that haven't been
 * migrated yet (committee-document-indexer, content-curator). New
 * code should call `readGoogleDocStructured` directly.
 */
async function readGoogleDoc(
  urlOrId: string,
  config: GoogleAuthConfig
): Promise<string> {
  const result = await readGoogleDocStructured(urlOrId, config);
  switch (result.status) {
    case 'invalid_input':
      throw new ToolError(result.message ?? 'Invalid Google Docs URL');
    case 'access_denied':
    case 'unsupported_type':
      return result.message ?? 'Unable to read document';
    case 'error':
      throw new ToolError(result.message ?? 'Error reading Google Doc');
    case 'empty':
      return `**${result.title ?? 'Untitled'}**\n\n(Document is empty)`;
    case 'ok': {
      const format = result.format && result.format !== 'markdown' ? ` (${result.format})` : '';
      const head = `**${result.title ?? 'Untitled'}**${format}`;
      const tail = result.truncated ? `\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]` : '';
      return `${head}\n\n${result.body}${tail}`;
    }
  }
}

/**
 * Tool definition for reading Google Docs
 */
export const GOOGLE_DOCS_TOOLS: AddieTool[] = [
  {
    name: 'read_google_doc',
    description: `Read a Google Doc, Sheet, Slide deck, or file from Google Drive. Returns a JSON object: \`{ "status": "ok" | "access_denied" | "empty" | "invalid_input" | "unsupported_type" | "error", "title": string | null, "body": string | null, "format": "markdown" | "csv" | "text" | null, "mime_type": string | null, "message": string | null, "truncated": boolean }\`. Branch on \`status\` — do not try to sniff error text out of \`body\`. On \`ok\`, Google Docs return markdown ready to pass straight to \`propose_content\`'s \`content\` field; pair with \`title\`. On \`access_denied\`, relay \`message\` (asks the user to share with ${ADDIE_EMAIL}).`,
    usage_hints: 'use when user shares a docs.google.com or drive.google.com link, or asks "can you read this doc"',
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

/**
 * Cap the body field in the LLM-facing JSON so one doc can't dominate
 * the context window. The inner 500KB cap in `readGoogleDocStructured`
 * still applies for internal callers that want the full body.
 */
const LLM_BODY_CAP = 30000;

/**
 * Create a structured Google Docs reader for internal callers (jobs,
 * services, curators) that want `GoogleDocResult` directly — without
 * going through the LLM-facing JSON-string handler.
 *
 * Returns null if GOOGLE_* credentials are not configured; callers
 * should branch on null to handle that case themselves.
 */
export function createGoogleDocsReader(): ((url: string) => Promise<GoogleDocResult>) | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const config: GoogleAuthConfig = { clientId, clientSecret, refreshToken };
  return (url: string) => readGoogleDocStructured(url, config);
}

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

      const result = await readGoogleDocStructured(url, config);

      // Cap body for LLM context — don't let one doc burn 30K+ tokens.
      // Internal callers (committee-document-indexer, content-curator)
      // hit the inner 500KB cap in readGoogleDocStructured and don't
      // pass through this handler.
      let body = result.body;
      let truncated = result.truncated;
      if (body && body.length > LLM_BODY_CAP) {
        body = body.substring(0, LLM_BODY_CAP);
        truncated = true;
      }

      return JSON.stringify({ ...result, body, truncated });
    },
  };
}
