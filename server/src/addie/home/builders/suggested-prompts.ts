/**
 * Suggested Prompts Builder
 *
 * Builds contextual conversation starters for Addie chat based on
 * the user's engagement state, membership, and activity.
 */

import type { SuggestedPrompt } from '../types.js';
import type { MemberContext } from '../../member-context.js';

/**
 * Build suggested prompts based on user context.
 * Returns 3-5 prompts ordered by relevance.
 */
export function buildSuggestedPrompts(
  memberContext: MemberContext,
  isAdmin: boolean
): SuggestedPrompt[] {
  const prompts: SuggestedPrompt[] = [];

  // Everyone gets a general help prompt
  prompts.push({
    label: 'What can you help me with?',
    prompt: 'What can you do? What kinds of things can I ask you about?',
  });

  if (!memberContext.is_member && !memberContext.is_mapped) {
    // Anonymous / not logged in — discovery prompts
    prompts.push({
      label: 'Learn about AdCP',
      prompt: 'What is AdCP and how does it work?',
    });
    prompts.push({
      label: 'AdCP vs programmatic',
      prompt: 'How is agentic advertising different from programmatic, and why does it matter?',
    });
    prompts.push({
      label: 'Why join?',
      prompt: 'What are the benefits of joining AgenticAdvertising.org?',
    });
    return prompts;
  }

  if (!memberContext.is_member) {
    // Logged in but not a member — conversion prompts
    prompts.push({
      label: 'Learn about AdCP',
      prompt: 'What is AdCP and how does it work?',
    });
    prompts.push({
      label: 'Membership options',
      prompt: 'What membership tiers are available and what do they include?',
    });
    prompts.push({
      label: 'Start the Academy',
      prompt: "I'd like to start learning AdCP in the Academy. What modules are available?",
    });
    return prompts;
  }

  // --- Member prompts: based on what they haven't done yet ---

  // Profile incomplete
  if (memberContext.community_profile && memberContext.community_profile.completeness < 80) {
    prompts.push({
      label: 'Complete my profile',
      prompt: 'Help me complete my community profile so I appear in search results.',
    });
  }

  // Not in any working groups
  if (!memberContext.working_groups || memberContext.working_groups.length === 0) {
    prompts.push({
      label: 'Find a working group',
      prompt: 'What working groups are available and which ones would be relevant for my work?',
    });
  }

  // Has working groups — offer deeper engagement
  if (memberContext.working_groups && memberContext.working_groups.length > 0) {
    const groupNames = memberContext.working_groups.map(g => g.name).join(', ');
    prompts.push({
      label: 'Working group updates',
      prompt: `What's happening in my working groups? I'm in: ${groupNames}`,
    });
  }

  // Academy prompt — always relevant for members
  const hasRecentConversations = memberContext.addie_history &&
    memberContext.addie_history.total_interactions > 5;
  if (!hasRecentConversations) {
    prompts.push({
      label: 'Start the Academy',
      prompt: "I'd like to start learning AdCP in the Academy. What modules are available?",
    });
  }

  // Builder prompt for tech-oriented personas
  if (memberContext.persona?.persona &&
    ['ad_tech_vendor', 'agency_tech', 'publisher_tech'].includes(memberContext.persona.persona)) {
    prompts.push({
      label: 'Build with AdCP',
      prompt: 'How do I set up a sales agent with AdCP? Walk me through the integration.',
    });
  }

  // Engagement score / industry context
  if (memberContext.engagement && memberContext.engagement.login_count_30d <= 2) {
    prompts.push({
      label: "What's new?",
      prompt: "What's been happening at AgenticAdvertising.org since I last checked in?",
    });
  }

  // Admin-specific
  if (isAdmin) {
    prompts.push({
      label: 'Admin overview',
      prompt: 'Give me a quick overview of member activity, flagged conversations, and anything that needs attention.',
    });
  }

  // If we don't have enough prompts, add a general learning one
  if (prompts.length < 4) {
    prompts.push({
      label: 'Learn about AdCP',
      prompt: 'What is AdCP and how does it work?',
    });
  }

  // Cap at 5
  return prompts.slice(0, 5);
}
