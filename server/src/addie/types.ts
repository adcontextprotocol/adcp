/**
 * Types for Addie - AAO's Community Agent
 */

/**
 * Slack Assistant thread started event
 */
export interface AssistantThreadStartedEvent {
  type: 'assistant_thread_started';
  assistant_thread: {
    user_id: string;
    context: {
      channel_id: string;
      team_id: string;
      enterprise_id?: string;
    };
  };
  event_ts: string;
  channel_id: string;
}

/**
 * Slack Assistant thread context changed event
 */
export interface AssistantThreadContextChangedEvent {
  type: 'assistant_thread_context_changed';
  assistant_thread: {
    user_id: string;
    context: {
      channel_id: string;
      team_id: string;
      enterprise_id?: string;
    };
  };
  event_ts: string;
  channel_id: string;
}

/**
 * Slack app mention event
 */
export interface AppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  event_ts: string;
}

/**
 * Message event in Assistant thread
 */
export interface AssistantMessageEvent {
  type: 'message';
  subtype?: string;
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  channel_type?: string;
  event_ts: string;
}

/**
 * Agent interaction audit log entry
 */
export interface AddieInteractionLog {
  id: string;
  timestamp: Date;
  event_type: 'assistant_thread' | 'mention' | 'dm' | 'email';
  channel_id: string;
  thread_ts?: string;
  user_id: string;
  input_text: string;
  input_sanitized: string;
  output_text: string;
  tools_used: string[];
  model: string;
  latency_ms: number;
  flagged: boolean;
  flag_reason?: string;
}

/**
 * Content sanitization result
 */
export interface SanitizationResult {
  valid: boolean;
  sanitized: string;
  flagged: boolean;
  reason?: string;
}

/**
 * Document from knowledge base or docs
 */
export interface Document {
  id: string;
  title: string;
  path: string;
  content: string;
  excerpt?: string;
}

/**
 * Search result from docs search
 */
export interface SearchResult {
  documents: Document[];
  query: string;
  total: number;
}

/**
 * Tool definition for Claude
 */
export interface AddieTool {
  name: string;
  /** Description of what the tool does (shown to Claude when using the tool) */
  description: string;
  /**
   * Usage hints for the router - explains WHEN to use this tool.
   * Example: 'use for "how does X work?", understanding concepts'
   * This helps the router distinguish intent (learning vs validation).
   */
  usage_hints?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Suggested prompt for Assistant UI
 */
export interface SuggestedPrompt {
  title: string;
  message: string;
}

// ============================================================================
// OUTBOUND PLANNER TYPES
// ============================================================================

/**
 * Goal category - what type of action is this?
 */
export type GoalCategory = 'information' | 'education' | 'invitation' | 'connection' | 'admin';

/**
 * Goal status in user history
 */
export type GoalStatus = 'pending' | 'sent' | 'responded' | 'success' | 'declined' | 'deferred';

/**
 * Outcome trigger type - what triggers this outcome?
 */
export type OutcomeTriggerType = 'sentiment' | 'intent' | 'keyword' | 'timeout' | 'default';

/**
 * Outcome type - what happened?
 */
export type OutcomeType = 'success' | 'defer' | 'clarify' | 'decline' | 'escalate';

/**
 * Planner decision method
 */
export type PlannerDecisionMethod = 'rule_match' | 'llm' | 'admin_override';

/**
 * Rehearsal session status
 */
export type RehearsalStatus = 'active' | 'completed' | 'abandoned';

/**
 * Outreach goal definition
 */
export interface OutreachGoal {
  id: number;
  name: string;
  category: GoalCategory;
  description: string | null;
  success_insight_type: string | null;

  // Eligibility criteria
  requires_mapped: boolean;
  requires_company_type: string[];
  requires_min_engagement: number;
  requires_insights: Record<string, string>;  // {insight_type: "any" | pattern}
  excludes_insights: Record<string, string>;

  // Priority
  base_priority: number;

  // Messages
  message_template: string;
  follow_up_on_question: string | null;
  follow_up_template: string | null;

  // Retry settings
  max_attempts: number;
  days_between_attempts: number;

  // Status
  is_enabled: boolean;

  // Audit
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Goal outcome - what happens based on response
 */
export interface GoalOutcome {
  id: number;
  goal_id: number;

  // Trigger
  trigger_type: OutcomeTriggerType;
  trigger_value: string | null;

  // Result
  outcome_type: OutcomeType;

  // Actions
  response_message: string | null;
  next_goal_id: number | null;
  defer_days: number | null;
  insight_to_record: string | null;
  insight_value: string | null;

  priority: number;
  created_at: Date;
}

/**
 * User's history with a specific goal
 */
export interface UserGoalHistory {
  id: number;
  slack_user_id: string;
  goal_id: number;

  status: GoalStatus;

  // Attempts
  attempt_count: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date | null;

  // Response
  outcome_id: number | null;
  response_text: string | null;
  response_sentiment: string | null;
  response_intent: string | null;

  // Planner context
  planner_reason: string | null;
  planner_score: number | null;
  decision_method: PlannerDecisionMethod | null;

  // Links
  outreach_id: number | null;
  thread_id: string | null;

  created_at: Date;
  updated_at: Date;
}

/**
 * Rehearsal message in a session
 */
export interface RehearsalMessage {
  role: 'addie' | 'user';
  content: string;
  timestamp: Date;
  goal_id?: number;
  analysis?: {
    sentiment: string;
    intent: string;
  };
  outcome?: {
    type: OutcomeType;
    next_goal_id?: number;
  };
}

/**
 * Rehearsal persona - simulated user context
 */
export interface RehearsalPersona {
  name: string;
  role?: string;
  company_type?: string;
  company_name?: string;
  engagement_score?: number;
  is_mapped?: boolean;
  existing_insights?: Array<{
    type: string;
    value: string;
  }>;
}

/**
 * Rehearsal session
 */
export interface RehearsalSession {
  id: number;
  admin_user_id: string;

  // Persona
  persona_name: string | null;
  persona_context: RehearsalPersona;

  // State
  current_goal_id: number | null;
  status: RehearsalStatus;
  messages: RehearsalMessage[];

  // Notes
  notes: string | null;
  outcome_summary: string | null;

  started_at: Date;
  ended_at: Date | null;
  created_at: Date;
}

/**
 * Capability states - what has/hasn't the member done?
 * Used by the planner to identify opportunities.
 */
export interface MemberCapabilities {
  // Account setup
  account_linked: boolean;
  profile_complete: boolean;
  offerings_set: boolean;
  email_prefs_configured: boolean;

  // Team
  has_team_members: boolean;
  is_org_admin: boolean;

  // Participation
  working_group_count: number;
  council_count: number;
  events_registered: number;
  events_attended: number;

  // Community
  community_profile_public: boolean;
  community_profile_completeness: number;  // 0-100

  // Engagement
  last_active_days_ago: number | null;
  slack_message_count_30d: number;
  is_committee_leader: boolean;
}

/**
 * Context for the outbound planner
 */
export interface PlannerContext {
  user: {
    slack_user_id: string;
    workos_user_id?: string;
    display_name?: string;
    is_mapped: boolean;
    /** Whether the user's org has an active AgenticAdvertising.org membership */
    is_member: boolean;
    engagement_score: number;
    insights: Array<{
      type: string;
      value: string;
      confidence: string;
    }>;
  };
  company?: {
    name: string;
    type: string;
    size?: string;
    offerings?: string[];
    /** Whether this is a real company org vs an auto-generated personal workspace */
    is_personal_workspace?: boolean;
  };
  /** What capabilities has/hasn't this member unlocked? */
  capabilities?: MemberCapabilities;
  history: UserGoalHistory[];
  contact_eligibility: {
    can_contact: boolean;
    reason: string;
    next_contact_date?: Date;
  };
}

/**
 * Planned action from the outbound planner
 */
export interface PlannedAction {
  goal: OutreachGoal;
  reason: string;
  priority_score: number;
  alternative_goals: OutreachGoal[];
  decision_method: PlannerDecisionMethod;
}

/**
 * Input for creating a new goal
 */
export interface CreateGoalInput {
  name: string;
  category: GoalCategory;
  description?: string;
  success_insight_type?: string;
  requires_mapped?: boolean;
  requires_company_type?: string[];
  requires_min_engagement?: number;
  requires_insights?: Record<string, string>;
  excludes_insights?: Record<string, string>;
  base_priority?: number;
  message_template: string;
  follow_up_on_question?: string;
  is_enabled?: boolean;
  created_by?: string;
}

/**
 * Input for creating a goal outcome
 */
export interface CreateOutcomeInput {
  goal_id: number;
  trigger_type: OutcomeTriggerType;
  trigger_value?: string;
  outcome_type: OutcomeType;
  response_message?: string;
  next_goal_id?: number;
  defer_days?: number;
  insight_to_record?: string;
  insight_value?: string;
  priority?: number;
}

/**
 * Input for starting a rehearsal session
 */
export interface StartRehearsalInput {
  admin_user_id: string;
  persona: RehearsalPersona;
}

/**
 * Result of simulating a user response in rehearsal
 */
export interface RehearsalResponseResult {
  analysis: {
    sentiment: string;
    intent: string;
  };
  matched_outcome: GoalOutcome | null;
  next_action: PlannedAction | null;
  addie_reply?: string;
}
