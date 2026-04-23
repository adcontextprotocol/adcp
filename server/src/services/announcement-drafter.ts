/**
 * Announcement Drafter
 *
 * Generates Slack + LinkedIn copy welcoming a new AAO member, using facts
 * pulled from the member's profile and brand.json. Pure service: takes
 * inputs, returns drafts. No DB writes, no Slack calls.
 *
 * Slack copy uses Slack mrkdwn conventions (`<url|label>` links, `•` bullets,
 * no markdown headers). LinkedIn copy is plain text with hashtags and a
 * double-newline paragraph style that pastes cleanly.
 */

import { complete } from '../utils/llm.js';
import { createLogger } from '../logger.js';

const logger = createLogger('announcement-drafter');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

export interface DrafterInputs {
  orgName: string;
  /** company_standard | company_icl | individual_professional | individual_academic */
  membershipTier: string | null;
  displayName: string;
  tagline: string | null;
  description: string | null;
  /** Offerings like "buyer_agent", "sales_agent", etc. */
  offerings: string[];
  primaryBrandDomain: string | null;
  /** Summarised agents from brand.json (type + short description) */
  agents: Array<{ type: string; description?: string | null }>;
  /** Profile slug for the public page link */
  profileSlug: string;
}

export interface AnnouncementDraft {
  slackText: string;
  linkedinText: string;
}

const SYSTEM_PROMPT = `You are AgenticAdvertising.org's community voice writing a welcome
announcement for a new paying member. Your audience is advertising,
media, and ad-tech practitioners who care about real capability, not
hype.

Rules:
- Draw only from the facts you are given. Do not invent offerings,
  agent capabilities, partnerships, or history.
- No hyperbole. Never use phrases like "thrilled to welcome",
  "excited to announce", "game-changing", "revolutionary".
- Match AAO's Addie voice: direct, warm, specific, a little dry.
- If the tagline is generic, lean on the offerings and agents for
  specificity. If those are thin too, stay short rather than padding.
- Do not use the member's voice ("we're ...") — write as AAO.
- Slack copy: Slack mrkdwn only. Use <url|label> for links.
  Use "•" for bullets if needed. No ** or ##. Keep to 60-90 words.
- LinkedIn copy: plain text, double newlines between paragraphs.
  Up to 3 short paragraphs. End with 2-4 relevant hashtags on their
  own line. 80-120 words. No emoji unless it's the AAO wave 👋
  opener — optional, used at most once.

Return JSON only, with exactly these keys:
{ "slack_text": "...", "linkedin_text": "..." }

No prose before or after. No markdown code fence.`;

function renderInputsForPrompt(input: DrafterInputs): string {
  const tierLabel = tierDescription(input.membershipTier);
  const offerings = input.offerings.length
    ? input.offerings.join(', ')
    : '(none listed)';
  const agents = input.agents.length
    ? input.agents
        .map((a) => `  - ${a.type}${a.description ? `: ${a.description}` : ''}`)
        .join('\n')
    : '  (none listed)';
  const profileUrl = `${APP_URL}/members/${input.profileSlug}`;

  return [
    `Member: ${input.orgName}`,
    `Tier: ${tierLabel}`,
    `Display name: ${input.displayName}`,
    `Tagline: ${input.tagline || '(none)'}`,
    `Description: ${input.description || '(none)'}`,
    `Offerings: ${offerings}`,
    `Primary brand domain: ${input.primaryBrandDomain || '(none)'}`,
    `Agents published on brand.json:`,
    agents,
    `Public profile URL (include in both drafts): ${profileUrl}`,
  ].join('\n');
}

function tierDescription(tier: string | null): string {
  switch (tier) {
    case 'company_icl':
      return 'Company (ICL)';
    case 'company_standard':
      return 'Company';
    case 'individual_professional':
      return 'Individual Professional';
    case 'individual_academic':
      return 'Individual Academic';
    default:
      return 'Member';
  }
}

/**
 * Parse the JSON blob the model returns. Tolerates a stray code fence or
 * leading/trailing whitespace but throws on anything stranger.
 */
export function parseDrafterResponse(raw: string): AnnouncementDraft {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Drafter returned non-JSON response: ${trimmed.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Drafter response was not a JSON object');
  }

  const { slack_text, linkedin_text } = parsed as Record<string, unknown>;
  if (typeof slack_text !== 'string' || typeof linkedin_text !== 'string') {
    throw new Error('Drafter response missing slack_text or linkedin_text');
  }
  if (!slack_text.trim() || !linkedin_text.trim()) {
    throw new Error('Drafter response had empty slack_text or linkedin_text');
  }

  return { slackText: slack_text.trim(), linkedinText: linkedin_text.trim() };
}

export async function draftAnnouncement(input: DrafterInputs): Promise<AnnouncementDraft> {
  const userMessage = renderInputsForPrompt(input);

  const result = await complete({
    system: SYSTEM_PROMPT,
    prompt: userMessage,
    model: 'primary',
    maxTokens: 800,
    operationName: 'announcement-drafter',
  });

  logger.debug(
    {
      orgName: input.orgName,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    },
    'Drafted announcement',
  );

  return parseDrafterResponse(result.text);
}
