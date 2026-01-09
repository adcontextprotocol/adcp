/**
 * Google Docs Integration for Addie
 *
 * Allows Addie to read Google Docs shared with her Google account.
 * Uses OAuth2 with a refresh token for authentication.
 */

import { logger } from '../../logger.js';
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
    return urlOrId;
  }

  try {
    const url = new URL(urlOrId);

    // docs.google.com/document/d/ID/...
    const docMatch = url.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (docMatch) return docMatch[1];

    // drive.google.com/file/d/ID/...
    const driveMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) return driveMatch[1];

    // drive.google.com/open?id=ID
    const idParam = url.searchParams.get('id');
    if (idParam) return idParam;

    // docs.google.com/spreadsheets/d/ID/... (bonus: also works for sheets)
    const sheetsMatch = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetsMatch) return sheetsMatch[1];

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
    return `Error: Could not extract document ID from "${urlOrId}". Please provide a valid Google Docs or Google Drive URL.`;
  }

  try {
    const auth = getAuthManager(config);
    const accessToken = await auth.getAccessToken();

    // First, check what type of file this is using Drive API
    const metadataResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}?fields=name,mimeType,capabilities`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }
    );

    if (!metadataResponse.ok) {
      if (metadataResponse.status === 404) {
        return `Error: Document not found. The document may have been deleted or the link is incorrect.`;
      }
      if (metadataResponse.status === 403) {
        return `I don't have access to this Google Doc. Please share it with ${ADDIE_EMAIL} and let me know when you've done that.`;
      }
      const error = await metadataResponse.text();
      logger.error({ error, status: metadataResponse.status, docId }, 'Google Docs: Failed to get metadata');
      return `Error: Failed to access document (${metadataResponse.status})`;
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
        return `Error: Failed to download file (${downloadResponse.status})`;
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
      if (exportResponse.status === 403) {
        return `I don't have access to export this document. Please share it with ${ADDIE_EMAIL} with at least "Viewer" permissions.`;
      }
      const error = await exportResponse.text();
      logger.error({ error, status: exportResponse.status, docId }, 'Google Docs: Failed to export');
      return `Error: Failed to export document (${exportResponse.status})`;
    }

    const content = await exportResponse.text();

    if (content.length > MAX_CONTENT_SIZE) {
      return `**${name}** (${exportFormat})\n\n${content.substring(0, MAX_CONTENT_SIZE)}\n\n[Content truncated to ${MAX_CONTENT_SIZE / 1024}KB]`;
    }

    return `**${name}** (${exportFormat})\n\n${content}`;
  } catch (error) {
    logger.error({ error, docId }, 'Google Docs: Unexpected error');
    if (error instanceof Error) {
      return `Error reading Google Doc: ${error.message}`;
    }
    return 'Error: Unknown error reading Google Doc';
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
        return 'Error: URL parameter is required and must be a non-empty string';
      }

      logger.info({ url }, 'Addie: Reading Google Doc');

      const result = await readGoogleDoc(url, config);

      // Truncate if too long
      if (result.length > 15000) {
        return result.substring(0, 15000) + '\n\n[Content truncated to 15,000 characters]';
      }

      return result;
    },
  };
}
