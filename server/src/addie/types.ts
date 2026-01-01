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
  event_type: 'assistant_thread' | 'mention' | 'dm';
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
 * Security validation result
 */
export interface ValidationResult {
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
