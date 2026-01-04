/**
 * Rehearsal Service
 *
 * Practice conversations with simulated personas before going live.
 * Uses the real outbound planner and response analysis, but doesn't
 * affect production metrics or send real messages.
 */

import { logger } from '../../logger.js';
import * as outboundDb from '../../db/outbound-db.js';
import { InsightsDatabase } from '../../db/insights-db.js';
import { OutboundPlanner, getOutboundPlanner } from './outbound-planner.js';
import type {
  RehearsalSession,
  RehearsalMessage,
  RehearsalPersona,
  PlannedAction,
  PlannerContext,
  GoalOutcome,
  OutreachGoal,
  RehearsalResponseResult,
  StartRehearsalInput,
} from '../types.js';

/**
 * Rehearsal Service - practice outbound conversations
 */
export class RehearsalService {
  private planner: OutboundPlanner;
  private insightsDb: InsightsDatabase;

  constructor() {
    this.planner = getOutboundPlanner();
    this.insightsDb = new InsightsDatabase();
  }

  /**
   * Start a new rehearsal session
   */
  async startSession(input: StartRehearsalInput): Promise<{
    session: RehearsalSession;
    planned_action: PlannedAction | null;
    message_preview: string | null;
  }> {
    // Create session in database
    const session = await outboundDb.createRehearsalSession({
      admin_user_id: input.admin_user_id,
      persona_name: input.persona.name,
      persona_context: input.persona,
    });

    // Build planner context from persona
    const ctx = this.buildPlannerContext(input.persona);

    // Get planner's recommendation
    const planned_action = await this.planner.planNextAction(ctx);

    // Build message preview if we have an action
    let message_preview: string | null = null;
    if (planned_action) {
      const linkUrl = 'https://agenticadvertising.org/auth/login?rehearsal=true';
      message_preview = this.planner.buildMessage(planned_action.goal, ctx, linkUrl);

      // Add Addie's message to the session
      await outboundDb.addRehearsalMessage(session.id, {
        role: 'addie',
        content: message_preview,
        timestamp: new Date(),
        goal_id: planned_action.goal.id,
      });
    }

    // Get updated session with message
    const updatedSession = await outboundDb.getRehearsalSession(session.id);

    logger.info({
      session_id: session.id,
      admin_user_id: input.admin_user_id,
      persona_name: input.persona.name,
      planned_goal: planned_action?.goal.name,
    }, 'Rehearsal session started');

    return {
      session: updatedSession ?? session,
      planned_action,
      message_preview,
    };
  }

  /**
   * Simulate a user response and see what happens
   */
  async simulateResponse(
    sessionId: number,
    responseText: string
  ): Promise<RehearsalResponseResult & { session: RehearsalSession }> {
    // Get session
    const session = await outboundDb.getRehearsalSession(sessionId);
    if (!session) {
      throw new Error(`Rehearsal session not found: ${sessionId}`);
    }

    if (session.status !== 'active') {
      throw new Error(`Session is ${session.status}, cannot add responses`);
    }

    // Analyze the response using existing sentiment/intent analysis
    const analysis = await this.analyzeResponse(responseText);

    // Add user message to session
    await outboundDb.addRehearsalMessage(sessionId, {
      role: 'user',
      content: responseText,
      timestamp: new Date(),
      analysis,
    });

    // Find matching outcome if we have a current goal
    let matched_outcome: GoalOutcome | null = null;
    let addie_reply: string | undefined;

    if (session.current_goal_id) {
      matched_outcome = await this.planner.findMatchingOutcome(
        session.current_goal_id,
        { ...analysis, keywords: this.extractKeywords(responseText) }
      );

      // If outcome has a response message, include it
      if (matched_outcome?.response_message) {
        addie_reply = matched_outcome.response_message;
      }

      // If outcome is 'clarify' and goal has follow_up_on_question, use that
      if (matched_outcome?.outcome_type === 'clarify') {
        const goal = await outboundDb.getGoal(session.current_goal_id);
        if (goal?.follow_up_on_question) {
          addie_reply = goal.follow_up_on_question;
        }
      }
    }

    // Determine next action based on outcome
    let next_action: PlannedAction | null = null;

    if (matched_outcome) {
      // Based on outcome type, decide what's next
      switch (matched_outcome.outcome_type) {
        case 'success':
          // Goal achieved - plan next action
          next_action = await this.planNextAfterSuccess(session, matched_outcome);
          break;

        case 'defer':
          // User wants to defer - note it but don't continue
          addie_reply = addie_reply ?? "No problem, I'll follow up later.";
          break;

        case 'clarify':
          // Need clarification - already set addie_reply above
          break;

        case 'decline':
          // User declined - note it and possibly try different goal
          addie_reply = addie_reply ?? "Understood, thanks for letting me know.";
          break;

        case 'escalate':
          // Needs human review
          addie_reply = addie_reply ?? "I'll have someone from the team reach out to help with that.";
          break;
      }
    } else {
      // No matching outcome - plan next based on current context
      const ctx = this.buildPlannerContext(session.persona_context);
      next_action = await this.planner.planNextAction(ctx);
    }

    // Add Addie's reply if we have one
    if (addie_reply) {
      await outboundDb.addRehearsalMessage(sessionId, {
        role: 'addie',
        content: addie_reply,
        timestamp: new Date(),
        goal_id: next_action?.goal.id,
        outcome: matched_outcome ? {
          type: matched_outcome.outcome_type,
          next_goal_id: matched_outcome.next_goal_id ?? undefined,
        } : undefined,
      });
    }

    // If we have a next action and no explicit reply, add the next goal message
    if (next_action && !addie_reply) {
      const ctx = this.buildPlannerContext(session.persona_context);
      const nextMessage = this.planner.buildMessage(
        next_action.goal,
        ctx,
        'https://agenticadvertising.org/auth/login?rehearsal=true'
      );
      await outboundDb.addRehearsalMessage(sessionId, {
        role: 'addie',
        content: nextMessage,
        timestamp: new Date(),
        goal_id: next_action.goal.id,
      });
      addie_reply = nextMessage;
    }

    // Get updated session
    const updatedSession = await outboundDb.getRehearsalSession(sessionId);

    logger.info({
      session_id: sessionId,
      response_sentiment: analysis.sentiment,
      response_intent: analysis.intent,
      outcome_type: matched_outcome?.outcome_type,
      next_goal: next_action?.goal.name,
    }, 'Rehearsal response simulated');

    return {
      analysis,
      matched_outcome,
      next_action,
      addie_reply,
      session: updatedSession ?? session,
    };
  }

  /**
   * Get the current message Addie would send for a session
   */
  async getCurrentMessage(sessionId: number): Promise<{
    goal: OutreachGoal | null;
    message: string | null;
    alternatives: OutreachGoal[];
  }> {
    const session = await outboundDb.getRehearsalSession(sessionId);
    if (!session) {
      throw new Error(`Rehearsal session not found: ${sessionId}`);
    }

    const ctx = this.buildPlannerContext(session.persona_context);
    const planned = await this.planner.planNextAction(ctx);

    if (!planned) {
      return { goal: null, message: null, alternatives: [] };
    }

    const message = this.planner.buildMessage(
      planned.goal,
      ctx,
      'https://agenticadvertising.org/auth/login?rehearsal=true'
    );

    return {
      goal: planned.goal,
      message,
      alternatives: planned.alternative_goals,
    };
  }

  /**
   * Complete a rehearsal session
   */
  async completeSession(
    sessionId: number,
    notes?: string,
    outcome_summary?: string
  ): Promise<RehearsalSession> {
    const session = await outboundDb.completeRehearsalSession(sessionId, {
      status: 'completed',
      notes,
      outcome_summary,
    });

    if (!session) {
      throw new Error(`Rehearsal session not found: ${sessionId}`);
    }

    logger.info({
      session_id: sessionId,
      outcome_summary,
      message_count: session.messages.length,
    }, 'Rehearsal session completed');

    return session;
  }

  /**
   * Abandon a rehearsal session
   */
  async abandonSession(sessionId: number): Promise<RehearsalSession> {
    const session = await outboundDb.completeRehearsalSession(sessionId, {
      status: 'abandoned',
    });

    if (!session) {
      throw new Error(`Rehearsal session not found: ${sessionId}`);
    }

    return session;
  }

  /**
   * List rehearsal sessions
   */
  async listSessions(options?: {
    admin_user_id?: string;
    limit?: number;
  }): Promise<RehearsalSession[]> {
    return outboundDb.listRehearsalSessions(options);
  }

  /**
   * Get a rehearsal session by ID
   */
  async getSession(sessionId: number): Promise<RehearsalSession | null> {
    return outboundDb.getRehearsalSession(sessionId);
  }

  // =====================================================
  // PRIVATE HELPERS
  // =====================================================

  /**
   * Build planner context from a rehearsal persona
   */
  private buildPlannerContext(persona: RehearsalPersona): PlannerContext {
    const isMapped = persona.is_mapped ?? false;

    return {
      user: {
        slack_user_id: `rehearsal_${persona.name?.replace(/\s+/g, '_').toLowerCase() ?? 'user'}`,
        display_name: persona.name,
        is_mapped: isMapped,
        engagement_score: persona.engagement_score ?? 50,
        insights: (persona.existing_insights ?? []).map(i => ({
          type: i.type,
          value: i.value,
          confidence: 'high',
        })),
      },
      company: persona.company_type ? {
        name: persona.company_name ?? 'Test Company',
        type: persona.company_type,
      } : undefined,
      // Build capabilities based on persona settings
      // The planner checks capabilities to determine what goals are relevant
      capabilities: {
        account_linked: isMapped,
        profile_complete: false,  // Default to false, can be extended via persona
        offerings_set: false,
        email_prefs_configured: false,
        has_team_members: false,
        is_org_admin: false,
        working_group_count: 0,
        council_count: 0,
        events_registered: 0,
        events_attended: 0,
        last_active_days_ago: null,
        slack_message_count_30d: Math.round((persona.engagement_score ?? 50) / 5),  // Derive from engagement
        is_committee_leader: false,
      },
      history: [],  // Fresh history for rehearsal
      contact_eligibility: {
        can_contact: true,
        reason: 'Rehearsal mode',
      },
    };
  }

  /**
   * Analyze response for sentiment and intent
   */
  private async analyzeResponse(text: string): Promise<{
    sentiment: string;
    intent: string;
  }> {
    // Use the existing response analysis from insights-db
    try {
      const result = await this.insightsDb.analyzeResponse(text);
      return {
        sentiment: result?.sentiment ?? 'neutral',
        intent: result?.intent ?? 'question',
      };
    } catch {
      // Fallback to simple analysis
      return this.simpleAnalysis(text);
    }
  }

  /**
   * Simple fallback analysis
   */
  private simpleAnalysis(text: string): { sentiment: string; intent: string } {
    const lower = text.toLowerCase();

    // Sentiment
    let sentiment = 'neutral';
    if (lower.match(/\b(yes|sure|sounds good|interested|love|great|awesome)\b/)) {
      sentiment = 'positive';
    } else if (lower.match(/\b(no|not|don't|can't|won't|stop|unsubscribe|remove)\b/)) {
      sentiment = 'negative';
    }

    // Intent
    let intent = 'question';
    if (lower.match(/\b(yes|sure|sign me up|i'm in|interested)\b/)) {
      intent = 'converted';
    } else if (lower.match(/\b(maybe|later|not now|remind me|busy)\b/)) {
      intent = 'deferred';
    } else if (lower.match(/\b(what|how|why|tell me|explain)\b/)) {
      intent = 'question';
    } else if (lower.match(/\b(no|stop|unsubscribe|remove|don't contact)\b/)) {
      intent = 'refusal';
    }

    return { sentiment, intent };
  }

  /**
   * Extract keywords from text for outcome matching
   */
  private extractKeywords(text: string): string[] {
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 3);
    return [...new Set(words)];
  }

  /**
   * Plan next action after a successful goal completion
   */
  private async planNextAfterSuccess(
    session: RehearsalSession,
    outcome: GoalOutcome
  ): Promise<PlannedAction | null> {
    // If outcome specifies a next goal, use that
    if (outcome.next_goal_id) {
      const nextGoal = await outboundDb.getGoal(outcome.next_goal_id);
      if (nextGoal) {
        return {
          goal: nextGoal,
          reason: 'Suggested follow-up after successful response',
          priority_score: nextGoal.base_priority,
          alternative_goals: [],
          decision_method: 'rule_match',
        };
      }
    }

    // Otherwise, use planner with updated context
    // Simulate having gained the insight from the successful goal
    const ctx = this.buildPlannerContext(session.persona_context);

    // Add the insight we would have gained
    if (outcome.insight_to_record) {
      ctx.user.insights.push({
        type: outcome.insight_to_record,
        value: outcome.insight_value ?? 'known',
        confidence: 'high',
      });
    }

    return this.planner.planNextAction(ctx);
  }
}

// Singleton instance
let rehearsalServiceInstance: RehearsalService | null = null;

/**
 * Get the rehearsal service instance
 */
export function getRehearsalService(): RehearsalService {
  if (!rehearsalServiceInstance) {
    rehearsalServiceInstance = new RehearsalService();
  }
  return rehearsalServiceInstance;
}
