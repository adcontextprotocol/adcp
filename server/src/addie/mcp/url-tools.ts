/**
 * URL and File Fetching Tools for Addie
 *
 * These tools allow Addie to:
 * 1. Fetch and read content from URLs shared in messages
 * 2. Download and read files shared in Slack
 *
 * This gives Addie context about external content users reference.
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';

// Maximum content size to prevent memory issues (500KB for text, 20MB for images/PDFs)
const MAX_CONTENT_SIZE = 500 * 1024;
const MAX_BINARY_SIZE = 20 * 1024 * 1024; // 20MB for images/PDFs (Claude's limit)

// Maximum time to wait for fetch (10 seconds)
const FETCH_TIMEOUT_MS = 10000;

/**
 * Result from reading a file - can be text or multimodal content
 */
export interface FileReadResult {
  type: 'text' | 'image' | 'document';
  /** For text type: the text content */
  text?: string;
  /** For image/document type: base64-encoded data */
  data?: string;
  /** MIME type for binary content */
  media_type?: string;
  /** Original filename */
  filename?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Tool definitions for URL/file fetching
 */
export const URL_TOOLS: AddieTool[] = [
  {
    name: 'fetch_url',
    description:
      'Fetch and read the content of a web URL. Use this when a user shares a link and asks about it, or when you need to read external content. Returns the text content of the page. Note: Does not work for pages requiring authentication.',
    usage_hints: 'use when user shares a link and asks "what is this?", "can you read this?", "summarize this article"',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must be http:// or https://)',
        },
        extract_type: {
          type: 'string',
          enum: ['text', 'html', 'markdown'],
          description: 'How to extract content: text (plain text), html (raw HTML), markdown (converted to markdown). Default: text',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_slack_file',
    description:
      'Download and read a file that was shared in Slack. Use this when a user shares a file (PDF, document, text file, etc.) and asks about its contents. Provide the file URL from the shared file info.',
    usage_hints: 'use when user shares a file in Slack and asks "what is in this file?", "can you read this?"',
    input_schema: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          description: 'The url_private or permalink from the Slack file share',
        },
        file_name: {
          type: 'string',
          description: 'The file name (helps with parsing)',
        },
      },
      required: ['file_url'],
    },
  },
];

/**
 * Fetch content from a URL
 */
async function fetchUrlContent(
  url: string,
  extractType: 'text' | 'html' | 'markdown' = 'text'
): Promise<string> {
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return `Error: Invalid URL format: ${url}`;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return `Error: Only HTTP and HTTPS URLs are supported`;
  }

  // Block obvious problematic domains
  const blockedDomains = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (blockedDomains.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith(`.${d}`))) {
    return `Error: Cannot fetch from local addresses`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Addie/1.0 (AgenticAdvertising.org AI Assistant)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    // Check content length
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_CONTENT_SIZE) {
      return `Error: Content too large (${Math.round(parseInt(contentLength) / 1024)}KB > ${MAX_CONTENT_SIZE / 1024}KB limit)`;
    }

    // Get content type
    const contentType = response.headers.get('content-type') || '';

    // Read content with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      return 'Error: Could not read response body';
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > MAX_CONTENT_SIZE) {
        reader.cancel();
        return `Error: Content too large (exceeded ${MAX_CONTENT_SIZE / 1024}KB limit during download)`;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    const rawContent = decoder.decode(new Uint8Array(chunks.flatMap(c => Array.from(c))));

    // Extract content based on type
    if (extractType === 'html') {
      return rawContent;
    }

    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      return rawContent;
    }

    // For HTML, extract text content
    const textContent = extractTextFromHtml(rawContent);

    if (extractType === 'markdown') {
      return convertHtmlToMarkdown(rawContent);
    }

    return textContent;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`;
      }
      return `Error: ${error.message}`;
    }
    return 'Error: Unknown fetch error';
  }
}

/**
 * Extract readable text from HTML
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style tags completely
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Replace block elements with newlines
  text = text
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi, '\n')
    .replace(/<\/?(ul|ol|table|thead|tbody)[^>]*>/gi, '\n\n');

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Clean up whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * Convert HTML to basic Markdown
 */
function convertHtmlToMarkdown(html: string): string {
  let md = html
    // Remove script and style
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Headers
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  // Bold and italic
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, '*$2*');

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

  // Paragraphs and breaks
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```\n');

  // Remove remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode entities and clean up
  md = md
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md;
}

/**
 * Read a file from Slack using the bot token
 * Returns structured data for multimodal content (images, PDFs)
 */
async function readSlackFile(
  fileUrl: string,
  fileName?: string,
  botToken?: string
): Promise<FileReadResult> {
  if (!botToken) {
    return { type: 'text', error: 'Slack bot token not available for file access' };
  }

  // Validate it's a Slack URL
  if (!fileUrl.includes('slack.com') && !fileUrl.includes('files.slack.com')) {
    return { type: 'text', error: 'Not a valid Slack file URL' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(fileUrl, {
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${botToken}`,
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      if (response.status === 404) {
        return { type: 'text', error: 'File not found or no longer available' };
      }
      if (response.status === 403) {
        return { type: 'text', error: 'Access denied - bot may not have permission to access this file' };
      }
      return { type: 'text', error: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');
    const ext = fileName?.split('.').pop()?.toLowerCase() || '';

    // Handle text-based files
    if (
      contentType.includes('text/') ||
      contentType.includes('application/json') ||
      contentType.includes('application/xml') ||
      ['txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'html', 'htm', 'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'sql'].includes(ext)
    ) {
      // Check size for text files
      if (contentLength && parseInt(contentLength) > MAX_CONTENT_SIZE) {
        return { type: 'text', error: `File too large (${Math.round(parseInt(contentLength) / 1024)}KB > ${MAX_CONTENT_SIZE / 1024}KB limit)` };
      }
      const text = await response.text();
      if (text.length > MAX_CONTENT_SIZE) {
        return {
          type: 'text',
          text: `File content (first ${MAX_CONTENT_SIZE / 1024}KB):\n\n${text.substring(0, MAX_CONTENT_SIZE)}...\n\n[Content truncated]`,
          filename: fileName,
        };
      }
      return { type: 'text', text: `File content:\n\n${text}`, filename: fileName };
    }

    // Handle PDF - return as document for Claude's native PDF support
    if (contentType.includes('application/pdf') || ext === 'pdf') {
      // Check size for binary files
      if (contentLength && parseInt(contentLength) > MAX_BINARY_SIZE) {
        return { type: 'text', error: `PDF too large (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB > ${MAX_BINARY_SIZE / 1024 / 1024}MB limit)` };
      }
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      logger.info({ fileName, size: buffer.byteLength }, 'Addie: Loaded PDF for multimodal processing');
      return {
        type: 'document',
        data: base64,
        media_type: 'application/pdf',
        filename: fileName,
      };
    }

    // Handle images - return as image for Claude's vision
    if (contentType.includes('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      // Check size for binary files
      if (contentLength && parseInt(contentLength) > MAX_BINARY_SIZE) {
        return { type: 'text', error: `Image too large (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB > ${MAX_BINARY_SIZE / 1024 / 1024}MB limit)` };
      }
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      // Determine proper media type
      let mediaType = contentType.split(';')[0].trim();
      if (!mediaType.startsWith('image/')) {
        // Infer from extension
        const extToMime: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
        };
        mediaType = extToMime[ext] || 'image/png';
      }
      logger.info({ fileName, size: buffer.byteLength, mediaType }, 'Addie: Loaded image for vision processing');
      return {
        type: 'image',
        data: base64,
        media_type: mediaType,
        filename: fileName,
      };
    }

    // Handle Word documents - extract text using mammoth (if available) or return error
    if (
      contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
      contentType.includes('application/msword') ||
      ['docx', 'doc'].includes(ext)
    ) {
      // Check size
      if (contentLength && parseInt(contentLength) > MAX_BINARY_SIZE) {
        return { type: 'text', error: `Word document too large (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB > ${MAX_BINARY_SIZE / 1024 / 1024}MB limit)` };
      }
      const buffer = await response.arrayBuffer();
      try {
        // Try to import mammoth dynamically
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
        logger.info({ fileName, textLength: result.value.length }, 'Addie: Extracted text from Word document');
        return {
          type: 'text',
          text: `Word document content:\n\n${result.value}`,
          filename: fileName,
        };
      } catch (mammothError) {
        logger.warn({ error: mammothError, fileName }, 'Addie: mammoth not available for Word doc extraction');
        return {
          type: 'text',
          error: `This is a Word document (${fileName || 'unnamed'}). Word document processing is not currently available. Please copy and paste the relevant text.`,
        };
      }
    }

    // Handle other binary files
    return {
      type: 'text',
      error: `This is a ${contentType || 'binary'} file (${fileName || 'unnamed'}). I cannot read the contents of this file type directly.`,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { type: 'text', error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds` };
      }
      return { type: 'text', error: error.message };
    }
    return { type: 'text', error: 'Unknown error reading file' };
  }
}

/**
 * Format a FileReadResult as a string for the tool response
 * For multimodal content, returns a special marker that the handler will process
 */
function formatFileResult(result: FileReadResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
  }

  if (result.type === 'text') {
    return result.text || 'No content';
  }

  // For images and documents, return a special JSON marker that the message handler will process
  // This allows the multimodal content to be passed to Claude as proper content blocks
  return `__MULTIMODAL_CONTENT__${JSON.stringify({
    type: result.type,
    data: result.data,
    media_type: result.media_type,
    filename: result.filename,
  })}__END_MULTIMODAL__`;
}

/**
 * Create tool handlers for URL/file fetching
 */
export function createUrlToolHandlers(slackBotToken?: string): Record<string, (input: Record<string, unknown>) => Promise<string>> {
  return {
    fetch_url: async (input: Record<string, unknown>) => {
      const url = input.url as string;
      const extractType = (input.extract_type as 'text' | 'html' | 'markdown') || 'text';

      logger.info({ url, extractType }, 'Addie: Fetching URL');

      const result = await fetchUrlContent(url, extractType);

      // Truncate if too long
      if (result.length > 10000) {
        return result.substring(0, 10000) + '\n\n[Content truncated to 10,000 characters]';
      }

      return result;
    },

    read_slack_file: async (input: Record<string, unknown>) => {
      const fileUrl = input.file_url as string;
      const fileName = input.file_name as string | undefined;

      logger.info({ fileUrl, fileName }, 'Addie: Reading Slack file');

      const result = await readSlackFile(fileUrl, fileName, slackBotToken);
      const formatted = formatFileResult(result);

      // Only truncate text content, not multimodal markers
      if (!formatted.startsWith('__MULTIMODAL_CONTENT__') && formatted.length > 10000) {
        return formatted.substring(0, 10000) + '\n\n[Content truncated to 10,000 characters]';
      }

      return formatted;
    },
  };
}

/**
 * Check if a tool result contains multimodal content
 */
export function isMultimodalContent(content: string): boolean {
  return content.startsWith('__MULTIMODAL_CONTENT__') && content.includes('__END_MULTIMODAL__');
}

/**
 * Extract multimodal content from a tool result
 */
export function extractMultimodalContent(content: string): FileReadResult | null {
  if (!isMultimodalContent(content)) {
    return null;
  }
  try {
    const jsonStr = content.replace('__MULTIMODAL_CONTENT__', '').replace('__END_MULTIMODAL__', '');
    return JSON.parse(jsonStr) as FileReadResult;
  } catch {
    return null;
  }
}
