/**
 * Types for the simulation engine.
 */

import type { RelationshipStage, SentimentTrend } from '../../../src/db/relationship-db.js';

// ---------------------------------------------------------------------------
// Person Profile (fixture format)
// ---------------------------------------------------------------------------

export interface SimPersonProfile {
  /** Unique archetype ID, e.g. "cold-email-prospect" */
  id: string;
  /** Human-readable description of this archetype */
  description: string;

  /** Relationship record to seed */
  relationship: {
    slack_user_id?: string;
    workos_user_id?: string;
    email?: string;
    prospect_org_id?: string;
    display_name?: string;
    stage: RelationshipStage;
    sentiment_trend?: SentimentTrend;
    interaction_count?: number;
    unreplied_outreach_count?: number;
    opted_out?: boolean;
    contact_preference?: 'slack' | 'email' | null;
    last_addie_message_at?: string | null;      // ISO string
    last_person_message_at?: string | null;
    next_contact_after?: string | null;
    slack_dm_channel_id?: string | null;
    slack_dm_thread_ts?: string | null;
  };

  /** Message history to seed into addie_threads + addie_thread_messages */
  messageHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
    channel: 'slack' | 'email' | 'web';
    /** Relative to simulation start, e.g. { days: -5 } means 5 days before start */
    relativeTime: { days?: number; hours?: number };
  }>;

  /** Organization to seed (for prospects) */
  organization?: {
    name: string;
    workos_organization_id: string;
    domain?: string;
    company_type?: string;
    persona?: string;
    prospect_contact_email?: string;
    prospect_contact_name?: string;
    prospect_owner?: string;
  };

  /** Insights to seed */
  insights?: Array<{
    type: string;
    value: string;
    confidence: string;
  }>;
}

// ---------------------------------------------------------------------------
// Timeline Events (simulation output)
// ---------------------------------------------------------------------------

export interface TimelineEvent {
  timestamp: Date;
  personId: string;
  personName: string;
  type:
    | 'outreach_decided'
    | 'outreach_skipped'
    | 'message_sent'
    | 'message_received'
    | 'stage_changed'
    | 'user_action'
    | 'compose_skipped'
    | 'error';
  channel?: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Simulated User Actions
// ---------------------------------------------------------------------------

export type SimulatedAction =
  | { type: 'slack_message'; text: string }
  | { type: 'email_reply'; text: string }
  | { type: 'link_account'; workosUserId: string }
  | { type: 'join_working_group'; groupSlug: string }
  | { type: 'web_chat_message'; text: string }
  | { type: 'opt_out' }
  | { type: 'opt_in' };

// ---------------------------------------------------------------------------
// Outreach Cycle Result
// ---------------------------------------------------------------------------

export interface OutreachCycleResult {
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
  /** Events generated during this cycle */
  events: TimelineEvent[];
}

// ---------------------------------------------------------------------------
// Simulation Report
// ---------------------------------------------------------------------------

export interface SimulationReport {
  duration: {
    start: Date;
    end: Date;
    simDays: number;
  };
  profiles: Array<{
    id: string;
    description: string;
    personId: string;
    startStage: RelationshipStage;
    endStage: RelationshipStage;
    messagesReceived: number;
    messagesSent: number;
    stageTransitions: Array<{ from: string; to: string; at: Date }>;
  }>;
  outreachCycles: number;
  totalDecisions: number;
  totalSent: number;
  totalSkipped: number;
  timeline: TimelineEvent[];
}

// ---------------------------------------------------------------------------
// LLM Mock Mode
// ---------------------------------------------------------------------------

export type LlmMode = 'canned' | 'live' | 'record';

export interface CannedResponse {
  scenarioStep: string;
  channel: 'slack' | 'email';
  response: string;
}
