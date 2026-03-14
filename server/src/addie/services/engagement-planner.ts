/**
 * Engagement Planner
 *
 * Relationship-aware engagement system that decides WHEN and WHAT to say
 * to each person based on their full relationship context. Replaces the
 * goal-based OutboundPlanner with Sonnet-composed, contextual messages.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { ModelConfig } from '../../config/models.js';
import * as outboundDb from '../../db/outbound-db.js';
import * as relationshipDb from '../../db/relationship-db.js';
import { STAGE_ORDER } from '../../db/relationship-db.js';
import type { PersonRelationship, RelationshipStage } from '../../db/relationship-db.js';
import type { MemberCapabilities } from '../types.js';

const logger = createLogger('engagement-planner');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface RelationshipContext {
  relationship: PersonRelationship;
  recentMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    channel: string;
    created_at: Date;
  }>;
  profile: {
    insights: Array<{ type: string; value: string; confidence: string }>;
    capabilities: MemberCapabilities | null;
    company: {
      name: string;
      type: string;
      persona?: string;
      is_member: boolean;
    } | null;
  };
  availableActions: string[];
}

interface EngagementDecision {
  shouldContact: boolean;
  reason: string;
  channel: 'slack' | 'email';
}

interface ComposedMessage {
  text: string;
  subject?: string;
  html?: string;
  goalHint?: string;
}

export type { RelationshipContext, EngagementDecision, ComposedMessage };

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Minimum days between proactive contacts, by stage. */
const STAGE_COOLDOWNS: Record<RelationshipStage, number> = {
  prospect: 0,
  welcomed: 3,
  exploring: 7,
  participating: 14,
  contributing: 30,
  leading: 30,
};

const COMPOSE_SYSTEM_PROMPT = `You are Addie, the community manager at AgenticAdvertising.org. You maintain an ongoing relationship with each member and prospect.

You are composing a proactive message to continue your conversation with this person. This is NOT a cold outreach — you know this person and have context about your relationship.

Guidelines:
- Write as if you're picking up a conversation, not starting one
- Reference specifics: their company, what they've said before, what they've done
- If this is a first message (stage: prospect), welcome them warmly to AgenticAdvertising.org
- If they're exploring, help them discover features relevant to their work
- If they're participating, share relevant updates or connect them with relevant people
- If they're contributing or leading, be supportive — they don't need guidance
- Keep it short. 2-4 sentences for Slack. 2-4 short paragraphs for email.
- One clear next step or question, max. Don't overwhelm.
- No marketing language, no exclamation marks in subject lines
- Sign as "Addie" with no last name
- If the reason for contact is "monthly pulse", this person hasn't responded in a while. Share something genuinely useful — a relevant community update, event, or resource. Do NOT reference their silence, do NOT mention that you've reached out before, do NOT say "I don't want to keep pinging you." Just share something valuable as if catching up with a colleague.
- Vary your suggestions. Don't always suggest the same action (like linking accounts). Pick the most relevant one for THIS person.
- Be genuine. If you have nothing meaningful to say AND this is not a welcome message, respond with skip. But welcome messages to new prospects should NEVER be skipped — every new member deserves a greeting.

For Slack: respond with just the message text.
For email: respond with JSON: {"subject": "...", "body": "..."}
If you have nothing meaningful to say (and this is NOT a welcome), respond with: {"skip": true, "reason": "..."}`;

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

const client = new Anthropic({
  apiKey: process.env.ADDIE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
});

// -----------------------------------------------------------------------------
// shouldContact
// -----------------------------------------------------------------------------

/**
 * Rule-based check: should Addie proactively reach out to this person right now?
 * Fast — no LLM call.
 */
export function shouldContact(relationship: PersonRelationship): EngagementDecision {
  const no = (reason: string): EngagementDecision => ({
    shouldContact: false,
    reason,
    channel: 'slack',
  });

  if (relationship.opted_out) {
    return no('opted out');
  }

  // Annoyance prevention: after 3+ unreplied, switch to monthly pulse.
  // After 2 unreplied: back off to next stage's cooldown.
  // After 3+ unreplied: monthly pulse only (30-day minimum spacing).
  const MAX_UNREPLIED_BEFORE_PULSE = 3;
  const MONTHLY_PULSE_DAYS = 30;
  if (relationship.unreplied_outreach_count >= MAX_UNREPLIED_BEFORE_PULSE) {
    if (relationship.last_addie_message_at) {
      const daysSinceLast =
        (Date.now() - relationship.last_addie_message_at.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLast < MONTHLY_PULSE_DAYS) {
        return no(`${relationship.unreplied_outreach_count} unreplied — monthly pulse in ${Math.ceil(MONTHLY_PULSE_DAYS - daysSinceLast)}d`);
      }
    }
    // 30+ days since last message — allow monthly pulse
    return { shouldContact: true, reason: 'monthly pulse — low-key update', channel: relationship.contact_preference ?? (relationship.slack_user_id ? 'slack' : 'email') };
  }

  if (relationship.next_contact_after && relationship.next_contact_after > new Date()) {
    return no('cooldown — next contact after ' + relationship.next_contact_after.toISOString());
  }

  // Check stage-based cooldown on last_addie_message_at
  // If 2+ unreplied messages, use the next stage's (longer) cooldown
  if (relationship.last_addie_message_at) {
    const daysSinceLast =
      (Date.now() - relationship.last_addie_message_at.getTime()) / (1000 * 60 * 60 * 24);
    let cooldown = STAGE_COOLDOWNS[relationship.stage];
    // Escalate cooldown if we have unreplied messages
    if (relationship.unreplied_outreach_count >= 2) {
      const currentIdx = STAGE_ORDER.indexOf(relationship.stage);
      const nextStage = STAGE_ORDER[Math.min(currentIdx + 1, STAGE_ORDER.length - 1)];
      cooldown = Math.max(cooldown, STAGE_COOLDOWNS[nextStage]);
    }
    if (daysSinceLast < cooldown) {
      return no(
        `stage cooldown — ${relationship.stage} requires ${cooldown}d, only ${Math.round(daysSinceLast)}d since last message`
      );
    }
  }

  // Channel selection
  let channel: 'slack' | 'email';

  if (relationship.contact_preference) {
    channel = relationship.contact_preference;
  } else if (relationship.slack_user_id) {
    channel = 'slack';
  } else if (relationship.email) {
    channel = 'email';
  } else {
    return no('no reachable channel — no Slack ID or email');
  }

  // Prospects with no welcome yet — always contact
  if (relationship.stage === 'prospect' && relationship.last_addie_message_at === null) {
    return { shouldContact: true, reason: 'new prospect — welcome message', channel };
  }

  return { shouldContact: true, reason: 'eligible for proactive contact', channel };
}

// -----------------------------------------------------------------------------
// composeMessage
// -----------------------------------------------------------------------------

/**
 * Use Claude Sonnet to compose a contextual message for this person.
 * Returns null if Sonnet decides there's nothing meaningful to say.
 */
export async function composeMessage(
  ctx: RelationshipContext,
  channel: 'slack' | 'email',
  contactReason?: string
): Promise<ComposedMessage | null> {
  const userPrompt = buildComposePrompt(ctx, channel, contactReason);

  const response = await client.messages.create({
    model: ModelConfig.primary,
    max_tokens: 1024,
    system: COMPOSE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    logger.warn('Unexpected response type from model');
    return null;
  }

  const text = content.text.trim();

  // Try to parse as JSON (email response or skip)
  try {
    const parsed = JSON.parse(text);

    if (parsed.skip) {
      logger.info(
        { person_id: ctx.relationship.id, reason: parsed.reason },
        'Sonnet chose to skip — nothing meaningful to say'
      );
      return null;
    }

    if (parsed.subject && parsed.body) {
      return {
        text: parsed.body,
        subject: parsed.subject,
        html: textToEmailHtml(parsed.body),
        goalHint: inferGoalHint(parsed.body, ctx.availableActions),
      };
    }
  } catch {
    // Not JSON — treat as plain text (Slack message)
  }

  if (channel === 'email') {
    // Sonnet returned plain text but we need email format — wrap it
    return {
      text,
      subject: 'From Addie at AgenticAdvertising.org',
      html: textToEmailHtml(text),
      goalHint: inferGoalHint(text, ctx.availableActions),
    };
  }

  return {
    text,
    goalHint: inferGoalHint(text, ctx.availableActions),
  };
}

// -----------------------------------------------------------------------------
// getAvailableActions
// -----------------------------------------------------------------------------

/**
 * Returns a human-readable list of actions this person could take,
 * based on what they haven't done yet.
 */
export function getAvailableActions(
  relationship: PersonRelationship,
  capabilities: MemberCapabilities | null
): string[] {
  const actions: string[] = [];

  // No Slack linkage
  if (!relationship.slack_user_id && relationship.workos_user_id) {
    actions.push('Link their Slack account to the website');
  }

  // No website linkage
  if (relationship.slack_user_id && !relationship.workos_user_id) {
    actions.push('Link their Slack account to the website');
  }

  if (!capabilities) {
    // Without capabilities data, suggest membership if they're a prospect
    if (relationship.prospect_org_id) {
      actions.push('Become a member of AgenticAdvertising.org');
    }
    return actions;
  }

  if (!capabilities.profile_complete) {
    actions.push('Complete their organization profile');
  }

  if (!capabilities.community_profile_public) {
    actions.push('Join the community directory');
  }

  if (capabilities.working_group_count === 0 && !capabilities.is_committee_leader) {
    actions.push('Join a working group');
  }

  if (capabilities.events_registered === 0) {
    actions.push('Register for an upcoming event');
  }

  if (!capabilities.email_prefs_configured) {
    actions.push('Set up email preferences');
  }

  if (!capabilities.offerings_set && capabilities.profile_complete) {
    actions.push('Define their service offerings');
  }

  if (!capabilities.has_team_members && capabilities.is_org_admin) {
    actions.push('Invite team members to their organization');
  }

  // Membership suggestion for non-members who are Addie prospects
  if (!capabilities.account_linked && relationship.prospect_org_id) {
    actions.push('Become a member of AgenticAdvertising.org');
  }

  return actions;
}

// -----------------------------------------------------------------------------
// computeNextContactDate
// -----------------------------------------------------------------------------

/**
 * Returns the next allowed contact date based on stage cooldown.
 * Called after sending a proactive message.
 */
export function computeNextContactDate(stage: RelationshipStage): Date {
  const cooldownDays = STAGE_COOLDOWNS[stage];
  const next = new Date();
  next.setDate(next.getDate() + cooldownDays);
  return next;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildComposePrompt(ctx: RelationshipContext, channel: 'slack' | 'email', contactReason?: string): string {
  const r = ctx.relationship;

  const firstName = r.display_name?.trim().split(' ')[0] ?? 'there';
  const companyLine = ctx.profile.company
    ? `${ctx.profile.company.name} (${ctx.profile.company.type}${ctx.profile.company.persona ? ', ' + ctx.profile.company.persona : ''}${ctx.profile.company.is_member ? ', member' : ''})`
    : 'Unknown company';

  // Conversation history
  let conversationBlock: string;
  if (ctx.recentMessages.length > 0) {
    const messages = ctx.recentMessages.slice(-10);
    conversationBlock = messages
      .map(m => {
        const who = m.role === 'assistant' ? 'Addie' : firstName;
        const dateStr = m.created_at.toISOString().split('T')[0];
        return `[${dateStr} via ${m.channel}] ${who}: ${m.content}`;
      })
      .join('\n');
  } else {
    conversationBlock = 'No previous conversation.';
  }

  // Capabilities summary
  let capsSummary = 'No capability data available.';
  if (ctx.profile.capabilities) {
    const caps = ctx.profile.capabilities;
    const lines: string[] = [];
    lines.push(caps.account_linked ? 'Account linked' : 'Account not linked');
    lines.push(caps.profile_complete ? 'Profile complete' : 'Profile incomplete');
    if (caps.working_group_count > 0) lines.push(`In ${caps.working_group_count} working group(s)`);
    if (caps.council_count > 0) lines.push(`In ${caps.council_count} council(s)`);
    if (caps.events_registered > 0) lines.push(`Registered for ${caps.events_registered} event(s)`);
    if (caps.community_profile_public) lines.push('In community directory');
    if (caps.is_committee_leader) lines.push('Committee leader');
    if (caps.slack_message_count_30d > 0) lines.push(`${caps.slack_message_count_30d} Slack messages in last 30 days`);
    capsSummary = lines.join('\n  ');
  }

  // Insights
  const insightsSummary =
    ctx.profile.insights.length > 0
      ? ctx.profile.insights.map(i => `${i.type}: ${i.value} (${i.confidence})`).join('\n  ')
      : 'No insights yet.';

  // Available actions
  const actionsBlock =
    ctx.availableActions.length > 0
      ? ctx.availableActions.map(a => `- ${a}`).join('\n')
      : 'None — they seem to have everything set up.';

  return `## Contact reason
${contactReason ?? 'proactive outreach'}

## Person
- Name: ${firstName}
- Company: ${companyLine}
- Relationship stage: ${r.stage}
- Sentiment trend: ${r.sentiment_trend}
- Total interactions: ${r.interaction_count}
- Last Addie message: ${r.last_addie_message_at?.toISOString().split('T')[0] ?? 'never'}
- Last person message: ${r.last_person_message_at?.toISOString().split('T')[0] ?? 'never'}

## Recent conversation
${conversationBlock}

## What they've done
  ${capsSummary}

## What we know
  ${insightsSummary}

## Actions they could take
${actionsBlock}

## Channel
${channel === 'email' ? 'Email — respond with JSON {"subject": "...", "body": "..."}' : 'Slack DM — respond with just the message text.'}`;
}

/**
 * Convert plain text to simple email HTML (paragraphs and links).
 */
export function textToEmailHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const withLinks = escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    url => `<a href="${url.replace(/"/g, '&quot;')}">${url}</a>`
  );

  const paragraphs = withLinks
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
${paragraphs}
</body>
</html>`;
}

/**
 * Infer which available action the message hints at, for tracking purposes.
 */
function inferGoalHint(messageText: string, availableActions: string[]): string | undefined {
  const lower = messageText.toLowerCase();
  for (const action of availableActions) {
    // Check if key words from the action appear in the message
    const keywords = action.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matches = keywords.filter(k => lower.includes(k));
    if (matches.length >= 2) {
      return action;
    }
  }
  return undefined;
}
