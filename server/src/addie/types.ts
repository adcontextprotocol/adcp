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
// OUTREACH TYPES
// ============================================================================

export type OutreachChannel = 'slack' | 'email' | 'any';

/**
 * Capability states - what has/hasn't the member done?
 * Used by the engagement planner to identify opportunities.
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
