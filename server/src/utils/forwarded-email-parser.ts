/**
 * Forwarded Email Parser
 *
 * Parses forwarded email bodies to extract original recipients (TO/CC)
 * from quoted header blocks. Handles Gmail, Apple Mail, Outlook, and
 * generic forwarding formats.
 */

import { parseEmailAddress } from '../db/contacts-db.js';

/**
 * Maximum body size to parse (1MB) - prevents DoS on huge emails
 */
const MAX_BODY_SIZE = 1_000_000;

/**
 * Maximum header block size to examine (2KB is plenty for headers)
 */
const MAX_HEADER_BLOCK_SIZE = 2048;

/**
 * Result from parsing forwarded email headers
 */
export interface ForwardedEmailParseResult {
  isForwarded: boolean;
  originalFrom?: { email: string; displayName: string | null };
  originalTo: Array<{ email: string; displayName: string | null }>;
  originalCc: Array<{ email: string; displayName: string | null }>;
  originalSubject?: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Patterns for detecting forwarded emails in subject line
 */
const FORWARD_SUBJECT_PATTERNS = [
  /^Fwd?:\s*/i,        // "Fwd:" or "Fw:"
  /^Forwarded:\s*/i,   // "Forwarded:"
  /^\[Fwd\]\s*/i,      // "[Fwd]"
  /^\[Forwarded\]\s*/i, // "[Forwarded]"
];

/**
 * Patterns for detecting forwarded email markers in body
 * Each pattern captures the start of the forwarded header block
 */
const FORWARD_BODY_MARKERS = [
  // Gmail: "---------- Forwarded message ---------"
  { pattern: /-{5,}\s*Forwarded\s+message\s*-{5,}/i, confidence: 'high' as const },
  // Apple Mail: "Begin forwarded message:"
  { pattern: /Begin\s+forwarded\s+message:/i, confidence: 'high' as const },
  // Outlook: "-----Original Message-----"
  { pattern: /-{5,}\s*Original\s+Message\s*-{5,}/i, confidence: 'high' as const },
  // Generic: "---- Forwarded Message ----"
  { pattern: /-{3,}\s*Forwarded\s*-{3,}/i, confidence: 'medium' as const },
];

/**
 * Check if the subject line indicates a forwarded email
 */
function hasForwardedSubject(subject: string): boolean {
  const trimmed = subject.trim();
  return FORWARD_SUBJECT_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Find the start of a forwarded header block in the email body
 * Returns the index and confidence level, or null if not found
 */
function findForwardMarker(bodyText: string): { index: number; confidence: 'high' | 'medium' } | null {
  for (const { pattern, confidence } of FORWARD_BODY_MARKERS) {
    const match = bodyText.match(pattern);
    if (match && match.index !== undefined) {
      return { index: match.index + match[0].length, confidence };
    }
  }
  return null;
}

/**
 * Extract the header block from forwarded email body
 * Headers end at the first blank line or after all expected headers are found
 */
function extractHeaderBlock(bodyText: string, startIndex: number): string {
  // Start from the marker and look for the header block
  // Limit how much text we examine for headers to prevent performance issues
  const afterMarker = bodyText.substring(startIndex, startIndex + MAX_HEADER_BLOCK_SIZE);

  // Find the end of the header block (double newline or significant content start)
  // Headers typically end with a blank line before the message body
  const lines = afterMarker.split('\n');
  const headerLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines at the start
    if (headerLines.length === 0 && trimmed === '') {
      continue;
    }

    // Check if this looks like a header line (Key: Value or continuation)
    const isHeaderLine = /^(From|To|Cc|CC|Date|Sent|Subject|Reply-To):\s*/i.test(trimmed);
    const isContinuation = /^\s+/.test(line) && headerLines.length > 0;

    if (isHeaderLine || isContinuation) {
      headerLines.push(line);
    } else if (trimmed === '' && headerLines.length > 0) {
      // Blank line after headers - end of header block
      break;
    } else if (headerLines.length > 0) {
      // Non-header content after headers - end of block
      break;
    }

    // Safety limit - don't scan forever
    if (headerLines.length > 20) {
      break;
    }
  }

  return headerLines.join('\n');
}

/**
 * Parse a header value that may span multiple lines
 * Handles indented continuation lines using an iterative approach (avoids ReDoS)
 */
function parseHeaderValue(headerBlock: string, headerName: string): string | null {
  const lines = headerBlock.split('\n');
  let collecting = false;
  const valueLines: string[] = [];
  const headerPattern = new RegExp(`^${headerName}:\\s*(.*)$`, 'i');

  for (const line of lines) {
    if (collecting) {
      // Continuation line must start with whitespace
      if (/^\s+/.test(line)) {
        valueLines.push(line.trim());
      } else {
        break; // New header or content
      }
    } else {
      const match = line.match(headerPattern);
      if (match) {
        collecting = true;
        if (match[1]) valueLines.push(match[1].trim());
      }
    }
  }

  return valueLines.length > 0 ? valueLines.join(' ') : null;
}

/**
 * Parse a comma-separated list of email addresses
 * Handles quoted display names with commas, e.g., "Last, First" <email@example.com>
 */
function parseAddressList(headerValue: string): Array<{ email: string; displayName: string | null }> {
  if (!headerValue) {
    return [];
  }

  const addresses: Array<{ email: string; displayName: string | null }> = [];

  // Strategy: Find email addresses in angle brackets, then work backwards for display names
  // This handles: "Last, First" <email>, Name <email>, <email>, plain@email.com

  // First, try to split on commas that are followed by text containing < or @
  // This handles most cases while preserving commas in quoted names
  const parts = splitAddresses(headerValue);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    try {
      const parsed = parseEmailAddress(trimmed);
      if (parsed.email && parsed.email.includes('@')) {
        addresses.push({
          email: parsed.email,
          displayName: parsed.displayName,
        });
      }
    } catch {
      // Skip unparseable addresses
    }
  }

  return addresses;
}

/**
 * Split a comma-separated address list while respecting quoted strings
 * Commas inside quotes (display names) are preserved
 * Handles malformed input with unbalanced quotes/brackets gracefully
 */
function splitAddresses(input: string): string[] {
  const results: string[] = [];
  let current = '';
  let inQuotes = false;
  let depth = 0; // Track angle bracket depth

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"' && (i === 0 || input[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '<' && !inQuotes) {
      depth++;
      current += char;
    } else if (char === '>' && !inQuotes && depth > 0) {
      // Prevent negative depth from unbalanced brackets
      depth--;
      current += char;
    } else if (char === ',' && !inQuotes && depth === 0) {
      // This is a real separator
      if (current.trim()) {
        results.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }

  // Add remaining content even if quotes/brackets were unbalanced
  if (current.trim()) {
    results.push(current.trim());
  }

  return results;
}

/**
 * Format a parsed email address back to string format
 * Returns "Display Name <email>" or just "email" if no display name
 */
export function formatEmailAddress(addr: { email: string; displayName: string | null }): string {
  if (addr.displayName) {
    // Quote display name if it contains special characters
    const needsQuotes = /[,<>@"]/.test(addr.displayName);
    const name = needsQuotes ? `"${addr.displayName}"` : addr.displayName;
    return `${name} <${addr.email}>`;
  }
  return addr.email;
}

/**
 * Merge two address arrays, avoiding duplicates by email
 * The first array's entries take precedence
 */
export function mergeAddresses(existing: string[], additional: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  // Process existing addresses first
  for (const addr of existing) {
    const parsed = parseEmailAddress(addr);
    const normalizedEmail = parsed.email.toLowerCase();
    if (!seen.has(normalizedEmail)) {
      seen.add(normalizedEmail);
      result.push(addr);
    }
  }

  // Add new addresses that aren't duplicates
  for (const addr of additional) {
    const parsed = parseEmailAddress(addr);
    const normalizedEmail = parsed.email.toLowerCase();
    if (!seen.has(normalizedEmail)) {
      seen.add(normalizedEmail);
      result.push(addr);
    }
  }

  return result;
}

/**
 * Parse forwarded email headers from email body text
 *
 * Detects forwarded emails and extracts original TO/CC recipients
 * from quoted header blocks in the email body.
 *
 * @param subject - Email subject line (for FW:/Fwd: detection)
 * @param bodyText - Plain text email body
 * @returns Parsed forwarded email info, or isForwarded=false if not forwarded
 */
export function parseForwardedEmailHeaders(
  subject: string,
  bodyText: string | undefined
): ForwardedEmailParseResult {
  const emptyResult: ForwardedEmailParseResult = {
    isForwarded: false,
    originalTo: [],
    originalCc: [],
    confidence: 'low',
  };

  // Guard against missing or excessively large bodies
  if (!bodyText || bodyText.length > MAX_BODY_SIZE) {
    return emptyResult;
  }

  // Check for forward indicators
  const hasForwardSubject = hasForwardedSubject(subject);
  const forwardMarker = findForwardMarker(bodyText);

  // If no indicators at all, not a forwarded email
  if (!hasForwardSubject && !forwardMarker) {
    return emptyResult;
  }

  // Determine where to look for headers
  let headerBlock: string;
  let confidence: 'high' | 'medium' | 'low';

  if (forwardMarker) {
    // Found a body marker - extract header block after it
    headerBlock = extractHeaderBlock(bodyText, forwardMarker.index);
    confidence = forwardMarker.confidence;
  } else {
    // Only subject indicator - try to find headers at start of body
    // Look for a From: header near the beginning
    const fromMatch = bodyText.match(/^From:\s/im);
    if (fromMatch && fromMatch.index !== undefined && fromMatch.index < 500) {
      headerBlock = extractHeaderBlock(bodyText, fromMatch.index);
      confidence = 'medium';
    } else {
      // Can't find headers, return with low confidence
      return {
        isForwarded: true,
        originalTo: [],
        originalCc: [],
        confidence: 'low',
      };
    }
  }

  // Parse individual headers
  const fromValue = parseHeaderValue(headerBlock, 'From');
  const toValue = parseHeaderValue(headerBlock, 'To');
  const ccValue = parseHeaderValue(headerBlock, 'Cc') || parseHeaderValue(headerBlock, 'CC');
  const subjectValue = parseHeaderValue(headerBlock, 'Subject');

  // Parse addresses
  const originalFrom = fromValue ? parseAddressList(fromValue)[0] : undefined;
  const originalTo = toValue ? parseAddressList(toValue) : [];
  const originalCc = ccValue ? parseAddressList(ccValue) : [];

  // Adjust confidence based on what we found
  const hasUsefulData = originalTo.length > 0 || originalCc.length > 0;
  if (!hasUsefulData && confidence === 'high') {
    confidence = 'medium';
  }
  if (!hasUsefulData && confidence === 'medium') {
    confidence = 'low';
  }

  return {
    isForwarded: true,
    originalFrom,
    originalTo,
    originalCc,
    originalSubject: subjectValue || undefined,
    confidence,
  };
}
