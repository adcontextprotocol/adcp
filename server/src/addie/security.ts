/**
 * Security layer for Addie - input sanitization, output validation, audit logging
 *
 * Defenses against:
 * - Prompt injection attacks
 * - Information leakage
 * - Malicious content
 */

import { logger } from '../logger.js';
import type { SanitizationResult, AddieInteractionLog } from './types.js';

/**
 * Patterns that might indicate prompt injection attempts
 */
const SUSPICIOUS_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(everything|all|your)\s+(you\s+)?(know|learned|instructions?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?)/i,
  /new\s+instructions?:/i,
  /system\s*prompt:/i,
  /you\s+are\s+now\s+a/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /act\s+as\s+(if|though)/i,
  /role\s*play\s+as/i,

  // Trying to extract system prompt
  /what\s+(are|is)\s+your\s+(system\s+)?instructions?/i,
  /show\s+(me\s+)?your\s+(system\s+)?prompt/i,
  /reveal\s+your\s+(hidden|secret|system)/i,
  /print\s+your\s+(initial|system)\s+prompt/i,
  /output\s+your\s+(instructions|prompt)/i,

  // Delimiter injection
  /\[system\]/i,
  /\[user\]/i,
  /\[assistant\]/i,
  /<\|.*\|>/,
  /###\s*(system|user|assistant)/i,
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

  // Truncate very long outputs (increased to 10000 to support web search responses)
  const MAX_OUTPUT_LENGTH = 10000;
  let sanitized = text;
  if (text.length > MAX_OUTPUT_LENGTH) {
    sanitized = text.substring(0, MAX_OUTPUT_LENGTH) + '\n\n_[Response truncated]_';
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
      result = result.replace(
        new RegExp(`<@${slackUserId}>`, 'g'),
        `<@${slackUserId}|${escapedName}>`
      );
    }
  }

  return result;
}

/**
 * Wrap bare URLs in Slack explicit link format to preserve fragments.
 *
 * Slack's auto-linker can drop URL fragments (the #... portion),
 * which breaks Stripe checkout URLs that require the fragment for the
 * encrypted session data. Wrapping in <url> ensures Slack preserves
 * the full URL including fragments.
 *
 * Only wraps URLs not already inside Slack link syntax (< >).
 */
export function wrapUrlsForSlack(text: string): string {
  // Match bare URLs (http/https) not already wrapped in < >
  // Use negative lookbehind for < and ensure URL isn't followed by >
  // Also skip URLs inside backtick code spans
  return text.replace(
    /(?<![<`])(https?:\/\/[^\s>)`]+)/g,
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
