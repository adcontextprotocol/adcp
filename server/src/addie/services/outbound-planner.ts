/**
 * Outbound Planner
 *
 * Intelligent goal selection for proactive outreach.
 * Uses a hybrid approach: rules for eligibility filtering, LLM for nuanced selection.
 *
 * Key concepts:
 * - Goals are possibilities (information gathering, education, invitations)
 * - Each goal has eligibility criteria (company type, engagement level, required insights)
 * - Planner scores available goals and picks the best one for each user
 * - Every decision is explainable ("Selected because...")
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { ModelConfig } from '../../config/models.js';
import * as outboundDb from '../../db/outbound-db.js';
import { getRecommendedGroupsForOrg } from './group-recommendations.js';
import type {
  OutreachGoal,
  UserGoalHistory,
  PlannerContext,
  PlannedAction,
  PlannerDecisionMethod,
  GoalOutcome,
} from '../types.js';

/**
 * Outbound Planner - decides what goal to pursue with each user
 */
export class OutboundPlanner {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Plan the next action for a user
   * Returns null if no action should be taken
   */
  async planNextAction(ctx: PlannerContext): Promise<PlannedAction | null> {
    const startTime = Date.now();

    // Can't contact user? No action.
    if (!ctx.contact_eligibility.can_contact) {
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        reason: ctx.contact_eligibility.reason,
      }, 'Planner: Cannot contact user');
      return null;
    }

    // STAGE 1: Get enabled goals and filter by eligibility (rule-based, fast)
    const allGoals = await outboundDb.listGoals({ enabledOnly: true });
    let eligible = allGoals.filter(g => this.isEligible(g, ctx));

    if (eligible.length === 0) {
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        total_goals: allGoals.length,
      }, 'Planner: No eligible goals');
      return null;
    }

    // STAGE 1.5: Async eligibility checks (for goals that need database queries)
    eligible = await this.filterAsyncEligibility(eligible, ctx);

    if (eligible.length === 0) {
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        total_goals: allGoals.length,
      }, 'Planner: No eligible goals after async checks');
      return null;
    }

    // STAGE 2: Filter out recently attempted or completed goals
    const available = eligible.filter(g => this.isAvailable(g, ctx.history));

    if (available.length === 0) {
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        eligible_count: eligible.length,
      }, 'Planner: No available goals (all attempted recently)');
      return null;
    }

    // STAGE 3: Quick match for obvious cases (rule-based)
    const quickMatch = this.quickMatch(available, ctx);
    if (quickMatch) {
      quickMatch.decision_method = 'rule_match';
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        goal: quickMatch.goal.name,
        reason: quickMatch.reason,
        latency_ms: Date.now() - startTime,
      }, 'Planner: Quick match selected goal');
      return quickMatch;
    }

    // STAGE 4: LLM-based selection among candidates (nuanced)
    const llmResult = await this.llmSelect(available, ctx, startTime);
    logger.debug({
      slack_user_id: ctx.user.slack_user_id,
      goal: llmResult.goal.name,
      reason: llmResult.reason,
      latency_ms: Date.now() - startTime,
    }, 'Planner: LLM selected goal');
    return llmResult;
  }

  /**
   * Check if a goal is eligible for this user (rule-based)
   */
  private isEligible(goal: OutreachGoal, ctx: PlannerContext): boolean {
    // Check mapping requirement
    if (goal.requires_mapped && !ctx.user.is_mapped) {
      return false;
    }

    // Check company type requirement
    if (goal.requires_company_type.length > 0) {
      if (!ctx.company?.type) return false;
      if (!goal.requires_company_type.includes(ctx.company.type)) return false;
    }

    // Check persona requirement
    if (goal.requires_persona && goal.requires_persona.length > 0) {
      if (!ctx.company?.persona) return false;
      if (!goal.requires_persona.includes(ctx.company.persona)) return false;
    }

    // Check engagement requirement
    if (goal.requires_min_engagement > 0) {
      if (ctx.user.engagement_score < goal.requires_min_engagement) return false;
    }

    // Check required insights
    for (const [insightType, pattern] of Object.entries(goal.requires_insights)) {
      const hasInsight = ctx.user.insights.some(i => {
        if (i.type !== insightType) return false;
        if (pattern === 'any') return true;
        // Pattern matching (e.g., "senior|executive")
        const patterns = pattern.split('|');
        return patterns.some(p => i.value.toLowerCase().includes(p.toLowerCase()));
      });
      if (!hasInsight) return false;
    }

    // Check excluded insights (skip if user already has these)
    for (const [insightType, pattern] of Object.entries(goal.excludes_insights)) {
      const hasInsight = ctx.user.insights.some(i => {
        if (i.type !== insightType) return false;
        if (pattern === 'any') return true;
        const patterns = pattern.split('|');
        return patterns.some(p => i.value.toLowerCase().includes(p.toLowerCase()));
      });
      if (hasInsight) return false;  // Already has this insight, skip goal
    }

    // Skip intro/welcome goals for highly engaged users
    // These users are clearly already part of the community - no need to ask "what brings you here?"
    // Any of these indicators suggests the user is already engaged:
    if (goal.category === 'information' && goal.success_insight_type === 'initial_interest') {
      const caps = ctx.capabilities;
      if (caps?.is_committee_leader) return false;
      if (caps && caps.working_group_count > 0) return false;
      if (caps && caps.council_count > 0) return false;
      if (caps && caps.slack_message_count_30d >= 10) return false;
    }

    return true;
  }

  /**
   * Async eligibility filter for goals that require database queries.
   * Called after the fast synchronous isEligible check.
   */
  private async filterAsyncEligibility(
    goals: OutreachGoal[],
    ctx: PlannerContext
  ): Promise<OutreachGoal[]> {
    // Check if any goal needs async filtering
    const hasDiscoverEventsGoal = goals.some(g => g.name === 'Discover Events');

    if (!hasDiscoverEventsGoal) {
      return goals; // No async checks needed
    }

    // Check if there are relevant upcoming events for this user
    const eventCheck = await outboundDb.hasRelevantUpcomingEvents(
      ctx.user.workos_user_id,
      ctx.user.slack_user_id
    );

    // Filter out "Discover Events" if no relevant events exist
    if (!eventCheck.hasRelevantEvents) {
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        eventCheck: eventCheck.details,
        userLocation: eventCheck.userLocation,
      }, 'Planner: Skipping "Discover Events" - no relevant events for user');

      return goals.filter(g => g.name !== 'Discover Events');
    }

    return goals;
  }

  /**
   * Check if a goal is available (not recently attempted, not completed)
   */
  private isAvailable(goal: OutreachGoal, history: UserGoalHistory[]): boolean {
    const goalHistory = history.filter(h => h.goal_id === goal.id);

    for (const h of goalHistory) {
      // Already succeeded? Don't ask again.
      if (h.status === 'success') return false;

      // Declined? Don't ask again.
      if (h.status === 'declined') return false;

      // Currently in progress? Wait.
      if (h.status === 'pending' || h.status === 'sent') return false;

      // Deferred? Check if retry time has passed.
      if (h.status === 'deferred' && h.next_attempt_at) {
        if (new Date() < h.next_attempt_at) return false;
      }

      // Recently attempted? Add cooldown.
      if (h.last_attempt_at) {
        const daysSinceAttempt = (Date.now() - h.last_attempt_at.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceAttempt < 7) return false;  // 7-day cooldown
      }
    }

    return true;
  }

  /**
   * Quick match: rule-based selection for obvious cases
   * Uses capabilities to identify clear next steps
   */
  private quickMatch(goals: OutreachGoal[], ctx: PlannerContext): PlannedAction | null {
    const caps = ctx.capabilities;

    // If only one goal available, select it
    if (goals.length === 1) {
      return {
        goal: goals[0],
        reason: 'Only eligible goal available',
        priority_score: goals[0].base_priority,
        alternative_goals: [],
        decision_method: 'rule_match',
      };
    }

    // PRIORITY 1: Account linking for unmapped users
    if (!ctx.user.is_mapped || !caps?.account_linked) {
      const linkGoal = goals.find(g =>
        g.category === 'admin' && g.name.toLowerCase().includes('link')
      );
      if (linkGoal) {
        return {
          goal: linkGoal,
          reason: 'User needs to link account first',
          priority_score: 100,
          alternative_goals: goals.filter(g => g.id !== linkGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 2: Profile completion (only for paid members - profiles are only visible to members)
    // Skip for personal workspaces since those aren't real company profiles
    if (caps && !caps.profile_complete && ctx.user.is_member && !ctx.company?.is_personal_workspace) {
      const profileGoal = goals.find(g =>
        g.name.toLowerCase().includes('profile') && g.category === 'admin'
      );
      if (profileGoal) {
        return {
          goal: profileGoal,
          reason: 'Profile not complete - visible to other members once set up',
          priority_score: 85,
          alternative_goals: goals.filter(g => g.id !== profileGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 3: Community directory (for mapped users not yet in the directory)
    if (caps && caps.account_linked && !caps.community_profile_public) {
      const communityGoal = goals.find(g =>
        g.name.toLowerCase().includes('community directory') && g.category === 'admin'
      );
      if (communityGoal) {
        return {
          goal: communityGoal,
          reason: 'User has not joined the community directory yet',
          priority_score: 75,
          alternative_goals: goals.filter(g => g.id !== communityGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 3.5: Founding member deadline (time-sensitive, expires April 1 2026)
    if (new Date() < new Date('2026-04-01') && !ctx.user.is_member && !ctx.company?.is_personal_workspace) {
      const deadlineGoal = goals.find(g => g.name === 'Founding Member Deadline');
      if (deadlineGoal) {
        return {
          goal: deadlineGoal,
          reason: 'Founding member deadline approaching March 31',
          priority_score: 95,
          alternative_goals: goals.filter(g => g.id !== deadlineGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 3.6: Addie-owned prospects — prioritize invitation/membership goals
    // These are prospects Addie has triaged and claimed; she should nudge them toward membership
    if (ctx.company?.is_addie_prospect && !ctx.user.is_member) {
      const inviteGoal = goals.find(g => g.category === 'invitation');
      if (inviteGoal) {
        return {
          goal: inviteGoal,
          reason: 'Addie-owned prospect — prioritizing membership invitation',
          priority_score: 80,
          alternative_goals: goals.filter(g => g.id !== inviteGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 4: Vendor membership (tech companies benefit from profile visibility)
    // Only for non-members at vendor-type companies
    const vendorTypes = ['adtech', 'ai', 'data'];
    if (ctx.user.is_mapped && !ctx.user.is_member && ctx.company?.type && vendorTypes.includes(ctx.company.type)) {
      const vendorGoal = goals.find(g =>
        g.name.toLowerCase().includes('vendor') && g.category === 'invitation'
      );
      if (vendorGoal) {
        return {
          goal: vendorGoal,
          reason: 'Tech vendor not a member - profiles visible to members would help their business',
          priority_score: 75,
          alternative_goals: goals.filter(g => g.id !== vendorGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 5: Working group discovery (for engaged users with none)
    // Skip for committee leaders - they lead working groups even if not counted as members
    // Note: Leaders are now included in working_group_count via the query, but this explicit
    // check is kept for clarity and defense against query changes
    if (caps && caps.account_linked && !caps.is_committee_leader && caps.working_group_count === 0 && caps.slack_message_count_30d > 5) {
      const wgGoal = goals.find(g =>
        g.name.toLowerCase().includes('working group') && g.category === 'education'
      );
      if (wgGoal) {
        return {
          goal: wgGoal,
          reason: 'Active user not in any working groups - opportunity to increase participation',
          priority_score: 70,
          alternative_goals: goals.filter(g => g.id !== wgGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 5.5: Persona-based working group recommendation (for users with persona but no groups)
    if (caps && caps.account_linked && !caps.is_committee_leader && caps.working_group_count === 0 && ctx.company?.persona) {
      const personaGoal = goals.find(g =>
        g.requires_persona?.includes(ctx.company!.persona!)
      );
      if (personaGoal) {
        return {
          goal: personaGoal,
          reason: `${ctx.company.persona} persona matched - recommending persona-aligned group`,
          priority_score: 72,
          alternative_goals: goals.filter(g => g.id !== personaGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // PRIORITY 6: Re-engagement for dormant users
    if (caps && caps.last_active_days_ago !== null && caps.last_active_days_ago > 30) {
      const reengageGoal = goals.find(g =>
        g.name.toLowerCase().includes('re-engage') || g.name.toLowerCase().includes('dormant')
      );
      if (reengageGoal) {
        return {
          goal: reengageGoal,
          reason: `User inactive for ${caps.last_active_days_ago} days`,
          priority_score: 60,
          alternative_goals: goals.filter(g => g.id !== reengageGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    // If user has no insights at all, prioritize information gathering
    if (ctx.user.insights.length === 0) {
      const infoGoal = goals.find(g => g.category === 'information');
      if (infoGoal && goals.length <= 3) {
        return {
          goal: infoGoal,
          reason: 'No insights about user yet - gathering basic information',
          priority_score: infoGoal.base_priority,
          alternative_goals: goals.filter(g => g.id !== infoGoal.id).slice(0, 3),
          decision_method: 'rule_match',
        };
      }
    }

    return null;  // Needs LLM decision
  }

  /**
   * LLM-based selection: reason about which goal is best
   */
  private async llmSelect(
    goals: OutreachGoal[],
    ctx: PlannerContext,
    startTime: number
  ): Promise<PlannedAction> {
    const prompt = this.buildSelectionPrompt(goals, ctx);

    try {
      const response = await this.client.messages.create({
        model: ModelConfig.fast,  // Haiku for speed
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });

      const latencyMs = Date.now() - startTime;
      const content = response.content[0];

      if (content.type !== 'text') {
        throw new Error('Unexpected response type from LLM');
      }

      return this.parseSelection(content.text, goals, latencyMs, response.usage);
    } catch (error) {
      logger.error({ error }, 'Planner: LLM selection failed, falling back to priority');
      // Fallback: select highest priority goal
      const sorted = goals.sort((a, b) => b.base_priority - a.base_priority);
      return {
        goal: sorted[0],
        reason: 'Selected by priority (LLM selection failed)',
        priority_score: sorted[0].base_priority,
        alternative_goals: sorted.slice(1, 4),
        decision_method: 'rule_match',
      };
    }
  }

  /**
   * Build prompt for LLM goal selection
   */
  private buildSelectionPrompt(goals: OutreachGoal[], ctx: PlannerContext): string {
    const userInsights = ctx.user.insights.length > 0
      ? ctx.user.insights.map(i => `${i.type}: ${i.value} (${i.confidence})`).join('\n  - ')
      : 'Nothing yet';

    // Build capability summary
    const caps = ctx.capabilities;
    const capabilityLines: string[] = [];
    if (caps) {
      if (caps.profile_complete) capabilityLines.push('✓ Profile complete');
      else capabilityLines.push('✗ Profile incomplete');

      if (caps.offerings_set) capabilityLines.push('✓ Service offerings defined');
      else capabilityLines.push('✗ No offerings set');

      if (caps.working_group_count > 0) capabilityLines.push(`✓ In ${caps.working_group_count} working group(s)`);
      else capabilityLines.push('✗ Not in any working groups');

      if (caps.council_count > 0) capabilityLines.push(`✓ In ${caps.council_count} council(s)`);

      if (caps.community_profile_public) capabilityLines.push(`✓ In community directory (${caps.community_profile_completeness}% complete)`);
      else capabilityLines.push('✗ Not in community directory');

      if (caps.events_registered > 0) capabilityLines.push(`✓ Registered for ${caps.events_registered} event(s)`);
      else capabilityLines.push('✗ No event registrations');

      if (caps.has_team_members) capabilityLines.push('✓ Has team members');
      else capabilityLines.push('✗ No team members added');

      // Committee leader is now shown in Role section, not here

      if (caps.slack_message_count_30d > 0) {
        capabilityLines.push(`Activity: ${caps.slack_message_count_30d} Slack messages in last 30 days`);
      } else if (caps.last_active_days_ago !== null) {
        capabilityLines.push(`Activity: Last active ${caps.last_active_days_ago} days ago`);
      }
    }

    // Build role/position line
    const roleLines: string[] = [];
    if (caps?.is_committee_leader) roleLines.push('Committee Leader');
    if (caps && caps.council_count > 0) roleLines.push(`Council Member (${caps.council_count})`);
    if (caps && caps.working_group_count > 0) roleLines.push(`WG Member (${caps.working_group_count})`);
    const roleStr = roleLines.length > 0 ? roleLines.join(', ') : 'Community member';

    // Filter notes from insights for separate display
    const notes = ctx.user.insights.filter(i => i.type === 'note');
    const otherInsights = ctx.user.insights.filter(i => i.type !== 'note');
    const insightStr = otherInsights.length > 0
      ? otherInsights.map(i => `${i.type}: ${i.value} (${i.confidence})`).join('\n  - ')
      : 'Nothing yet';

    return `You are helping decide what capability or feature to introduce to a member of AgenticAdvertising.org.

## User Context
- Name: ${ctx.user.display_name ?? 'Unknown'}
- Company: ${ctx.company?.name ?? 'Unknown'}
- Role in Community: ${roleStr}
- Account Status: ${ctx.user.is_mapped ? 'Linked' : 'Not linked'}, ${ctx.user.is_member ? 'Paying member' : 'Not yet a member'}${ctx.company?.is_addie_prospect ? '\n- SDR Status: Addie-owned prospect (actively being nurtured toward membership)' : ''}
- Engagement Score: ${ctx.user.engagement_score}/100

## What They've Done (Capabilities)
${capabilityLines.length > 0 ? capabilityLines.map(l => `  ${l}`).join('\n') : '  No capability data available'}

## What We Know (Insights)
  - ${insightStr}
${notes.length > 0 ? `\n## Notes from Channel Conversations\n${notes.map(n => `  - ${n.value}`).join('\n')}` : ''}

## Available Goals (pick ONE)
${goals.map((g, i) => `${i + 1}. **${g.name}** (${g.category})
   Priority: ${g.base_priority}/100
   ${g.description ?? ''}
   ${g.success_insight_type ? `We'd learn: ${g.success_insight_type}` : ''}`).join('\n\n')}

## Instructions
Think about which CAPABILITY would be most valuable for this person to unlock next.
Consider:
1. What features haven't they used that could benefit them?
2. What's the logical next step in their journey?
3. What would help them get more value from the organization?

Respond ONLY with valid JSON (no markdown code blocks):
{"selected": <number 1-${goals.length}>, "reason": "<2-3 sentence explanation>"}`;
  }

  /**
   * Parse LLM selection response
   */
  private parseSelection(
    text: string,
    goals: OutreachGoal[],
    latencyMs: number,
    usage?: { input_tokens: number; output_tokens: number }
  ): PlannedAction {
    try {
      // Clean up potential markdown code blocks
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const selectedIndex = (parsed.selected ?? parsed.selected_goal_index ?? 1) - 1;
      if (selectedIndex < 0 || selectedIndex >= goals.length) {
        throw new Error(`Invalid selection index: ${selectedIndex + 1}`);
      }

      const selectedGoal = goals[selectedIndex];
      const alternativeGoals = goals.filter((_, i) => i !== selectedIndex).slice(0, 3);

      return {
        goal: selectedGoal,
        reason: parsed.reason ?? 'Selected by LLM',
        priority_score: selectedGoal.base_priority,
        alternative_goals: alternativeGoals,
        decision_method: 'llm',
      };
    } catch (error) {
      logger.warn({
        text,
        error,
      }, 'Planner: Failed to parse LLM response, using first goal');
      return {
        goal: goals[0],
        reason: 'Selected as fallback (parse error)',
        priority_score: goals[0].base_priority,
        alternative_goals: goals.slice(1, 4),
        decision_method: 'llm',
      };
    }
  }

  /**
   * Build a message from a goal template
   */
  buildMessage(goal: OutreachGoal, ctx: PlannerContext, linkUrl?: string): string {
    let message = goal.message_template;

    // Extract first name from display name (e.g., "Julie Lorin" -> "Julie")
    // Handle edge cases: empty strings, single-char names (like "J."), etc.
    const rawFirstName = ctx.user.display_name?.trim().split(' ')[0];
    const firstName = rawFirstName && rawFirstName.length > 1 ? rawFirstName : 'there';

    // Replace placeholders
    message = message.replace(/\{\{user_name\}\}/g, firstName);
    message = message.replace(/\{\{company_name\}\}/g, ctx.company?.name ?? 'your company');
    message = message.replace(/\{\{link_url\}\}/g, linkUrl ?? '');

    // Dynamic countdown for time-sensitive goals (founding member deadline)
    const daysRemaining = Math.max(0, Math.ceil((new Date('2026-04-01T00:00:00Z').getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
    message = message.replace(/\{\{days_remaining\}\}/g, String(daysRemaining));

    return message;
  }

  /**
   * Find matching outcome for a response
   */
  async findMatchingOutcome(
    goalId: number,
    analysis: { sentiment: string; intent: string; keywords?: string[] }
  ): Promise<GoalOutcome | null> {
    const outcomes = await outboundDb.listOutcomes(goalId);

    // Sort by priority (highest first)
    const sorted = outcomes.sort((a, b) => b.priority - a.priority);

    for (const outcome of sorted) {
      const matches = this.matchesOutcome(outcome, analysis);
      if (matches) {
        return outcome;
      }
    }

    // Return default outcome if exists
    return sorted.find(o => o.trigger_type === 'default') ?? null;
  }

  /**
   * Check if analysis matches an outcome trigger
   */
  private matchesOutcome(
    outcome: GoalOutcome,
    analysis: { sentiment: string; intent: string; keywords?: string[] }
  ): boolean {
    switch (outcome.trigger_type) {
      case 'sentiment':
        return analysis.sentiment === outcome.trigger_value;

      case 'intent':
        return analysis.intent === outcome.trigger_value;

      case 'keyword':
        if (!outcome.trigger_value || !analysis.keywords) return false;
        const keywords = outcome.trigger_value.toLowerCase().split(',').map(k => k.trim());
        return analysis.keywords.some(k => keywords.includes(k.toLowerCase()));

      case 'timeout':
        // Timeout is handled separately by the scheduler
        return false;

      case 'default':
        return true;

      default:
        return false;
    }
  }
}

// Singleton instance
let plannerInstance: OutboundPlanner | null = null;

/**
 * Get the outbound planner instance
 */
export function getOutboundPlanner(): OutboundPlanner {
  if (!plannerInstance) {
    plannerInstance = new OutboundPlanner();
  }
  return plannerInstance;
}
