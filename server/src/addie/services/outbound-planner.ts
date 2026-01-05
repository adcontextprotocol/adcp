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
import { eventsDb } from '../../db/events-db.js';
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
    const staticEligible = allGoals.filter(g => this.isEligible(g, ctx));
    // Dynamic eligibility checks (e.g., "Discover Events" requires events to exist)
    const eligible = await this.filterDynamicEligibility(staticEligible, ctx);

    if (eligible.length === 0) {
      logger.debug({
        slack_user_id: ctx.user.slack_user_id,
        total_goals: allGoals.length,
      }, 'Planner: No eligible goals');
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
      logger.info({
        slack_user_id: ctx.user.slack_user_id,
        goal: quickMatch.goal.name,
        reason: quickMatch.reason,
        latency_ms: Date.now() - startTime,
      }, 'Planner: Quick match selected goal');
      return quickMatch;
    }

    // STAGE 4: LLM-based selection among candidates (nuanced)
    const llmResult = await this.llmSelect(available, ctx, startTime);
    logger.info({
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

    return true;
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
   * Filter goals by dynamic eligibility (requires async checks)
   * Some goals depend on external state (e.g., events existing in DB)
   */
  private async filterDynamicEligibility(goals: OutreachGoal[], ctx: PlannerContext): Promise<OutreachGoal[]> {
    const results: OutreachGoal[] = [];

    for (const goal of goals) {
      // "Discover Events" requires upcoming events the user isn't already registered for
      if (goal.name === 'Discover Events') {
        const upcomingEvents = await eventsDb.getUpcomingEvents();
        if (upcomingEvents.length === 0) {
          logger.debug({ goal: goal.name }, 'Planner: Skipping goal - no upcoming events');
          continue;
        }

        // Check if user is already registered for all upcoming events
        if (ctx.user.workos_user_id) {
          const userRegistrations = await eventsDb.getUserRegistrations(ctx.user.workos_user_id);
          const registeredEventIds = new Set(
            userRegistrations
              .filter(r => r.registration_status !== 'cancelled')
              .map(r => r.event_id)
          );
          const unregisteredEvents = upcomingEvents.filter(e => !registeredEventIds.has(e.id));
          if (unregisteredEvents.length === 0) {
            logger.debug({
              goal: goal.name,
              total_upcoming: upcomingEvents.length,
              user_registered: registeredEventIds.size,
            }, 'Planner: Skipping goal - user registered for all upcoming events');
            continue;
          }
        }
      }
      results.push(goal);
    }

    return results;
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

    // PRIORITY 3: Vendor membership (tech companies benefit from profile visibility)
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

    // PRIORITY 4: Working group discovery (for engaged users with none)
    if (caps && caps.account_linked && caps.working_group_count === 0 && caps.slack_message_count_30d > 5) {
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

    // PRIORITY 5: Re-engagement for dormant users
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

      if (caps.events_registered > 0) capabilityLines.push(`✓ Registered for ${caps.events_registered} event(s)`);
      else capabilityLines.push('✗ No event registrations');

      if (caps.has_team_members) capabilityLines.push('✓ Has team members');
      else capabilityLines.push('✗ No team members added');

      if (caps.is_committee_leader) capabilityLines.push('✓ Committee leader');

      if (caps.slack_message_count_30d > 0) {
        capabilityLines.push(`Activity: ${caps.slack_message_count_30d} Slack messages in last 30 days`);
      } else if (caps.last_active_days_ago !== null) {
        capabilityLines.push(`Activity: Last active ${caps.last_active_days_ago} days ago`);
      }
    }

    return `You are helping decide what capability or feature to introduce to a member of AgenticAdvertising.org.

## User Context
- Name: ${ctx.user.display_name ?? 'Unknown'}
- Company: ${ctx.company?.name ?? 'Unknown'} (${ctx.company?.type ?? 'unknown type'})
- Account Status: ${ctx.user.is_mapped ? 'Linked' : 'Not linked'}
- Engagement Score: ${ctx.user.engagement_score}/100

## What They've Done (Capabilities)
${capabilityLines.length > 0 ? capabilityLines.map(l => `  ${l}`).join('\n') : '  No capability data available'}

## What We Know (Insights)
  - ${userInsights}

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
