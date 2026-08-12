/**
 * Security layer for Addie - input sanitization, output validation, audit logging
 *
 * Defenses against:
 * - Prompt injection attacks
 * - Information leakage
 * - Malicious content
 */

import { createLogger } from '../logger.js';

const logger = createLogger('addie-security');
import type { SanitizationResult, AddieInteractionLog } from './types.js';
import { PERSONA_COLLAPSE_PATTERNS } from './response-postprocess.js';

export const MAX_OUTPUT_LENGTH = 10_000;
export const OUTPUT_TRUNCATION_SUFFIX = '… Reply “continue” for the rest.';
const OUTPUT_TRUNCATION_SEPARATOR = '\n\n';

const SENTENCE_ENDINGS = new Set(['.', '!', '?', '。', '！', '？']);
const SENTENCE_CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '*', '_', '~', '`']);

function hasValidFenceCloserTail(text: string, start: number): boolean {
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === '\r' || character === '\n') return true;
    if (character !== ' ' && character !== '\t') return false;
  }
  return true;
}

/**
 * Find the best neutral Markdown boundary in one grapheme-aware pass.
 * Marker runs are skipped by the Segmenter loop after being counted, so every
 * input offset is examined a constant number of times.
 */
function findSafeOutputBoundary(text: string, maxLength: number): number {
  const limit = Math.max(0, Math.min(maxLength, text.length));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  let lastSentenceBoundary = -1;
  let lastWhitespaceBoundary = -1;
  let pendingSentenceBoundary: number | null = null;
  let skipUntil = 0;

  let fenceMarker: '`' | '~' | null = null;
  let fenceLength = 0;
  let inlineBacktickLength = 0;
  let linkLabelDepth = 0;
  let awaitingLinkDestination = false;
  let linkDestinationDepth = 0;
  let escaped = false;

  let lineCanOpenFence = true;
  let lineIndent = 0;

  const isMarkdownNeutral = () => fenceMarker === null
    && inlineBacktickLength === 0
    && linkLabelDepth === 0
    && !awaitingLinkDestination
    && linkDestinationDepth === 0;
  const isNeutral = () => isMarkdownNeutral() && !escaped;

  const updateLineState = (grapheme: string) => {
    if (/[\r\n]/u.test(grapheme)) {
      lineCanOpenFence = true;
      lineIndent = 0;
    } else if (lineCanOpenFence && grapheme === ' ' && lineIndent < 4) {
      lineIndent++;
      if (lineIndent > 3) lineCanOpenFence = false;
    } else {
      lineCanOpenFence = false;
    }
  };

  for (const part of segmenter.segment(text)) {
    const index = part.index;
    const grapheme = part.segment;
    const end = index + grapheme.length;

    if (index < skipUntil) continue;

    // One look-ahead grapheme may confirm punctuation exactly at the budget.
    if (index >= limit || end > limit) {
      if (pendingSentenceBoundary !== null && isNeutral() && /\s/u.test(grapheme)) {
        lastSentenceBoundary = pendingSentenceBoundary;
      }
      break;
    }

    const marker = grapheme === '`' || grapheme === '~' ? grapheme : null;
    let markerRunLength = 0;
    if (marker !== null) {
      if (escaped && isMarkdownNeutral()) {
        // A backslash escapes only the immediately following marker.
        markerRunLength = 1;
      } else {
        while (
          index + markerRunLength < limit
          && text[index + markerRunLength] === marker
        ) {
          markerRunLength++;
        }
      }
      skipUntil = index + markerRunLength;
    }

    if (fenceMarker !== null) {
      if (
        marker === fenceMarker
        && lineCanOpenFence
        && markerRunLength >= fenceLength
        && hasValidFenceCloserTail(text, index + markerRunLength)
      ) {
        fenceMarker = null;
        fenceLength = 0;
      }
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    }

    if (inlineBacktickLength > 0) {
      if (marker === '`' && markerRunLength === inlineBacktickLength) {
        inlineBacktickLength = 0;
      }
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    }

    if (linkLabelDepth > 0) {
      if (escaped) {
        escaped = false;
      } else if (grapheme === '\\') {
        escaped = true;
      } else if (grapheme === '[') {
        linkLabelDepth++;
      } else if (grapheme === ']') {
        linkLabelDepth--;
        if (linkLabelDepth === 0) awaitingLinkDestination = true;
      }
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    }

    if (awaitingLinkDestination) {
      awaitingLinkDestination = false;
      if (grapheme === '(') {
        linkDestinationDepth = 1;
        pendingSentenceBoundary = null;
        updateLineState(grapheme);
        continue;
      }
    }

    if (linkDestinationDepth > 0) {
      if (escaped) {
        escaped = false;
      } else if (grapheme === '\\') {
        escaped = true;
      } else if (grapheme === '(') {
        linkDestinationDepth++;
      } else if (grapheme === ')') {
        linkDestinationDepth--;
      }
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    }

    const wasEscaped = escaped;
    if (escaped) {
      escaped = false;
    } else if (grapheme === '\\') {
      escaped = true;
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    } else if (marker !== null && markerRunLength >= 3 && lineCanOpenFence) {
      fenceMarker = marker;
      fenceLength = markerRunLength;
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    } else if (marker === '`') {
      inlineBacktickLength = markerRunLength;
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    } else if (grapheme === '[') {
      linkLabelDepth = 1;
      pendingSentenceBoundary = null;
      updateLineState(grapheme);
      continue;
    }

    if (/\s/u.test(grapheme) && !wasEscaped) {
      if (pendingSentenceBoundary !== null) {
        lastSentenceBoundary = pendingSentenceBoundary;
        pendingSentenceBoundary = null;
      }
      if (index > 0) lastWhitespaceBoundary = index;
    } else if (
      pendingSentenceBoundary !== null
      && SENTENCE_CLOSERS.has(grapheme)
    ) {
      pendingSentenceBoundary = end;
    } else {
      pendingSentenceBoundary = SENTENCE_ENDINGS.has(grapheme) ? end : null;
    }

    updateLineState(grapheme);
  }

  if (
    limit === text.length
    && pendingSentenceBoundary !== null
    && isNeutral()
  ) {
    lastSentenceBoundary = pendingSentenceBoundary;
  }

  return lastSentenceBoundary >= 0
    ? lastSentenceBoundary
    : lastWhitespaceBoundary;
}

/**
 * Format a partial response at a sentence boundary and add the canonical
 * continuation cue. The content budget reserves room for the separator and
 * cue, so the complete delivered value never exceeds the 10k cap.
 */
export function formatTruncatedOutput(
  text: string,
  maxLength: number = MAX_OUTPUT_LENGTH,
): string {
  const contentBudget = Math.max(
    0,
    maxLength - OUTPUT_TRUNCATION_SEPARATOR.length - OUTPUT_TRUNCATION_SUFFIX.length,
  );
  const limit = Math.max(0, Math.min(contentBudget, text.length));
  const contentEnd = findSafeOutputBoundary(text, limit);
  const content = contentEnd > 0 ? text.slice(0, contentEnd).trimEnd() : '';
  return content
    ? `${content}${OUTPUT_TRUNCATION_SEPARATOR}${OUTPUT_TRUNCATION_SUFFIX}`
    : OUTPUT_TRUNCATION_SUFFIX;
}

/**
 * Patterns that might indicate prompt injection attempts
 */
const SUSPICIOUS_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(?:all\s)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/i,
  /forget\s+(?:everything|all|your)\s+(?:you\s)?(?:know|learned|instructions?)/i,
  /disregard\s+(?:all\s)?(?:previous|prior|your)\s+(?:instructions?|rules?)/i,
  /new\s+instructions?:/i,
  /system\s*prompt:/i,
  /you\s+are\s+now\s+a/i,
  /pretend\s+(?:you\s+are|to\s+be)/i,
  /act\s+as\s+(?:if|though)/i,
  /role\s*play\s+as/i,

  // Identity-substitution: "you are actually Claude / really ChatGPT / in fact an AI model"
  /you(?:['’]?re|\s+are)\s+(?:actually|really|secretly|in\s+fact|truly)\s+(?:claude|chatgpt|gpt-?\d*|gemini|llama|bard|an?\s+(?:ai|a\.i\.|artificial\s+intelligence|language\s+model))/i,

  // Trying to extract system prompt
  /what\s+(?:are|is)\s+your\s+(?:system\s)?instructions?/i,
  /show\s+(?:me\s)?your\s+(?:system\s)?prompt/i,
  /reveal\s+your\s+(?:hidden|secret|system)/i,
  /print\s+your\s+(?:initial|system)\s+prompt/i,
  /output\s+your\s+(?:instructions|prompt)/i,

  // Delimiter injection
  /\[system\]/i,
  /\[user\]/i,
  /\[assistant\]/i,
  /<\|[^|]*\|>/,
  /###\s*(?:system|user|assistant)/i,
];

/**
 * Content that should never appear in Addie's output
 */
const FORBIDDEN_OUTPUT_PATTERNS = [
  // System prompt leakage indicators
  /you\s+are\s+addie.*community\s+agent/i,
  /your\s+instructions\s+are/i,
  /my\s+system\s+prompt\s+(is|says)/i,

  // API keys and secrets (common patterns)
  /sk-[a-zA-Z0-9]{32,}/,
  /xoxb-[a-zA-Z0-9-]+/,
  /ghp_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,

  // Model/provider self-disclosure. The deterministic rewrite in
  // response-postprocess.ts removes these before delivery; flagging them here
  // is the audit canary that tells us when a leak slipped past the rewrite.
  ...PERSONA_COLLAPSE_PATTERNS,
];

/**
 * Sanitize user input before passing to Claude
 */
export function sanitizeInput(text: string): SanitizationResult {
  let sanitized = text;
  let flagged = false;
  let reason: string | undefined;

  // Check for suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text)) {
      flagged = true;
      reason = `Suspicious pattern detected`;
      logger.warn({ pattern: pattern.source.substring(0, 50) }, 'Addie: Suspicious input pattern');
      break;
    }
  }

  // Remove potential delimiter injection
  sanitized = sanitized
    .replace(/\[system\]/gi, '[sys tem]')
    .replace(/\[user\]/gi, '[us er]')
    .replace(/\[assistant\]/gi, '[assis tant]');

  // Limit message length to prevent context stuffing
  const MAX_LENGTH = 4000;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH) + '... [truncated]';
    if (!flagged) {
      flagged = true;
      reason = 'Message truncated due to excessive length';
    }
  }

  return {
    valid: true,
    sanitized,
    flagged,
    reason,
  };
}

/**
 * Convert markdown links to Slack mrkdwn format.
 * Markdown: [text](url) -> Slack mrkdwn: <url|text>
 *
 * @deprecated Claude now outputs the correct link format based on channel context.
 * This function is kept for backwards compatibility but is no longer used in validation.
 *
 * Note: URLs with unbalanced parentheses (e.g., Wikipedia links like
 * https://en.wikipedia.org/wiki/Foo_(bar)) may not convert correctly.
 * This is a known limitation of simple regex-based parsing.
 */
export function markdownToSlackLinks(text: string): string {
  // Match markdown links: [text](url)
  // Capture group 1: link text, Capture group 2: URL
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    // Escape pipe characters in link text to prevent breaking Slack mrkdwn
    // lgtm[js/incomplete-sanitization] -- only pipe needs escaping for Slack mrkdwn <url|text> syntax
    const escapedText = linkText.replace(/\|/g, '\\|');
    return `<${url}|${escapedText}>`;
  });
}

/**
 * Validate output before sending to Slack
 */
export function validateOutput(text: string): SanitizationResult {
  let flagged = false;
  let reason: string | undefined;

  // Check for forbidden patterns
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      flagged = true;
      reason = `Output may contain sensitive content`;
      logger.warn({ pattern: pattern.source.substring(0, 30) }, 'Addie: Suspicious output pattern');
      break;
    }
  }

  // Truncate very long outputs at a sentence boundary. This validator is used
  // by Slack, web chat, email, and handler surfaces, so the cap stays uniform.
  let sanitized = text;
  if (text.length > MAX_OUTPUT_LENGTH) {
    sanitized = formatTruncatedOutput(text);
    logger.error(
      { originalLength: text.length, deliveredLength: sanitized.length, maxLength: MAX_OUTPUT_LENGTH },
      'Addie: Output truncated at sentence boundary',
    );
    if (!flagged) {
      flagged = true;
      reason = 'Output truncated due to length';
    }
  }

  // Note: Link format conversion removed - Claude now outputs correct format
  // based on channel context (Slack mrkdwn or web markdown)

  return {
    valid: !flagged || (reason?.includes('truncated') ?? false),
    sanitized,
    flagged,
    reason,
  };
}

/**
 * Strip bot mention from message text
 */
export function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

/**
 * Resolve Slack user mentions to include names for better LLM understanding.
 *
 * Converts raw Slack mentions like <@U0A1RAMRWNS> to annotated format like
 * <@U0A1RAMRWNS|Ankuj> so the LLM can understand who is being mentioned.
 *
 * @param text - Message text containing Slack mentions
 * @param lookupUser - Function to look up user name by Slack ID
 * @returns Text with resolved mentions
 */
export async function resolveSlackMentions(
  text: string,
  lookupUser: (slackUserId: string) => Promise<string | null>
): Promise<string> {
  // Find all Slack user mentions: <@U...> (not already resolved with |name)
  const mentionPattern = /<@(U[A-Z0-9]+)>(?!\|)/g;
  const mentions = [...text.matchAll(mentionPattern)];

  if (mentions.length === 0) {
    return text;
  }

  // Look up each mentioned user
  let result = text;
  for (const match of mentions) {
    const slackUserId = match[1];
    const name = await lookupUser(slackUserId);
    if (name) {
      // Escape $ characters in name to prevent special replacement string behavior
      // In JS replace(), $ has special meaning ($&, $1, $', $`)
      const escapedName = name.replace(/\$/g, '$$$$');
      // Replace <@U...> with <@U...|Name> so LLM knows who is mentioned
      // Escape regex special characters in the Slack user ID to prevent regex injection
      const escapedSlackUserId = slackUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(
        new RegExp(`<@${escapedSlackUserId}>`, 'g'),
        `<@${slackUserId}|${escapedName}>`
      );
    }
  }

  return result;
}

/**
 * Wrap bare URLs in Slack explicit link format to preserve fragments and stop
 * Slack's auto-linker from sweeping wrapping punctuation into the link target.
 *
 * Slack's auto-linker has two failure modes:
 *  1. It drops URL fragments (#...), which breaks Stripe checkout URLs that
 *     require the fragment for the encrypted session data.
 *  2. It includes trailing punctuation in the link target, so a model that
 *     emits `**URL**` produces a click to `URL**` and 404s.
 *
 * Wrapping in `<url>` Slack-explicit-link syntax fixes both — but only if our
 * URL boundary regex stops at the same characters Slack would otherwise use
 * as wrappers. The character class below excludes whitespace and the
 * characters that wrap URLs in chat output: `>`, `)`, backtick, `*`, `"`, `'`.
 *
 * Only wraps URLs not already inside Slack link syntax (< >).
 */
export function wrapUrlsForSlack(text: string): string {
  // Match bare URLs (http/https) not already wrapped in < >
  // Use negative lookbehind for < and ensure URL isn't followed by >
  // Also skip URLs inside backtick code spans
  return text.replace(
    /(?<![<`])(https?:\/\/[^\s>)`*"']+)/g,
    (match, url, offset) => {
      // Check if we're inside a backtick code span
      const before = text.substring(0, offset);
      const backtickCount = (before.match(/`/g) || []).length;
      if (backtickCount % 2 === 1) {
        return match; // Inside code span, don't wrap
      }
      return `<${url}>`;
    }
  );
}

export interface BareJsonGuardResult {
  text: string;
  wasWrapped: boolean;
}

/**
 * Wrap a response in a ```json fence if it's a bare JSON envelope (starts with
 * `{` or `[` and parses cleanly). Tool results are meant to be interpreted by
 * Claude, not echoed verbatim; if one ends up in the Slack message body, this
 * keeps it readable and flags it for investigation.
 *
 * Known limitation: this catches the common "bare JSON at the top of the
 * message" case. A response that starts with a short prose prefix before the
 * JSON (e.g. "Here is the result: {...}") will not be wrapped. The prompt
 * rule in behaviors.md is the primary control; this guard is a safety net.
 *
 * The log line intentionally does NOT include the response content, because
 * the cases that trigger this wrap are exactly the cases where the payload
 * is most likely to contain PII, Stripe data, or other secrets pulled from a
 * tool result.
 */
export function guardBareJsonEnvelope(
  text: string,
  context: { pathTag: string },
): BareJsonGuardResult {
  const trimmed = text.trim();
  if (trimmed.length < 2) return { text, wasWrapped: false };

  const first = trimmed[0];
  if (first !== '{' && first !== '[') return { text, wasWrapped: false };

  // Skip if the response already starts with a code fence that wraps the JSON.
  if (/^```/.test(text.trimStart())) return { text, wasWrapped: false };

  try {
    JSON.parse(trimmed);
  } catch {
    return { text, wasWrapped: false };
  }

  logger.warn(
    {
      pathTag: context.pathTag,
      length: text.length,
      firstChar: first,
      looksLikeArray: first === '[',
    },
    'Addie: Raw JSON envelope detected in outbound response — wrapping in code fence',
  );

  return {
    text: '```json\n' + trimmed + '\n```',
    wasWrapped: true,
  };
}

/**
 * Extract markdown images from text and return them separately.
 * Used to convert markdown image syntax into Slack Block Kit image blocks,
 * since Slack's mrkdwn format does not render ![alt](url).
 *
 * Only extracts images from allowed hosts (docs.adcontextprotocol.org)
 * to prevent arbitrary image injection.
 */
export interface ExtractedImage {
  alt: string;
  url: string;
}

export interface ImageExtractionResult {
  text: string;
  images: ExtractedImage[];
}

export function extractMarkdownImages(text: string): ImageExtractionResult {
  const images: ExtractedImage[] = [];

  // Match ![alt](url) syntax — only extract from allowed hosts
  const cleaned = text.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,
    (_match, alt, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && parsed.hostname === 'docs.adcontextprotocol.org') {
          images.push({ alt: (alt || 'Image').substring(0, 2000), url });
          return '';
        }
      } catch {
        // Malformed URL, skip extraction
      }
      return _match; // Leave non-allowed host images as-is
    }
  );

  // Collapse triple+ blank lines left by image removal
  const tidied = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { text: tidied, images };
}

/**
 * Log an interaction for audit purposes
 */
export function logInteraction(log: AddieInteractionLog): void {
  const emoji = log.flagged ? '⚠️ ' : '';
  logger.info(
    {
      interactionId: log.id,
      eventType: log.event_type,
      userId: log.user_id,
      channelId: log.channel_id,
      latencyMs: log.latency_ms,
      deliveryStatus: log.delivery_status,
      toolsUsed: log.tools_used,
      flagged: log.flagged,
      flagReason: log.flag_reason,
    },
    `${emoji}Addie interaction completed`
  );
}

/**
 * Generate a unique ID for interactions
 */
export function generateInteractionId(): string {
  return `addie_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
