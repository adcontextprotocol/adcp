import { query } from './client.js';

// ============== Types ==============

export interface ConversationStats {
  total_threads: number;
  total_messages: number;
  unique_users: number;
  by_channel: Record<string, number>;
  avg_rating: number | null;
  sentiment_breakdown: Record<string, number>;
  outcome_breakdown: Record<string, number>;
  escalation_count: number;
  escalation_by_category: Record<string, number>;
}

export interface QuestionTheme {
  theme: string;
  count: number;
  description: string;
  example_questions: string[];
}

export interface DocumentationGap {
  topic: string;
  evidence: string;
  suggested_action: string;
}

export interface TrainingGap {
  topic: string;
  evidence: string;
  suggested_module: string;
}

export interface AddieImprovement {
  area: string;
  evidence: string;
  suggested_fix: string;
  severity: 'low' | 'medium' | 'high';
}

export interface EscalationPattern {
  pattern: string;
  count: number;
  root_cause: string;
  suggested_action: string;
}

export interface ConversationAnalysis {
  executive_summary: string;
  question_themes: QuestionTheme[];
  documentation_gaps: DocumentationGap[];
  training_gaps: TrainingGap[];
  addie_improvements: AddieImprovement[];
  escalation_patterns: EscalationPattern[];
}

export interface ConversationInsightsRecord {
  id: number;
  week_start: Date;
  week_end: Date;
  status: 'generated' | 'posted' | 'failed';
  stats: ConversationStats;
  analysis: ConversationAnalysis;
  model_used: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  latency_ms: number | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  created_at: Date;
}

// ============== Operations ==============

/**
 * Create a new insight record. Returns null if one already exists for this week.
 */
export async function createInsight(
  weekStart: string,
  weekEnd: string,
  stats: ConversationStats,
  analysis: ConversationAnalysis,
  llmMeta: { model: string; tokensInput?: number; tokensOutput?: number; latencyMs?: number },
): Promise<ConversationInsightsRecord | null> {
  const result = await query<ConversationInsightsRecord>(
    `INSERT INTO conversation_insights (week_start, week_end, stats, analysis, model_used, tokens_input, tokens_output, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (week_start) DO NOTHING
     RETURNING *`,
    [
      weekStart,
      weekEnd,
      JSON.stringify(stats),
      JSON.stringify(analysis),
      llmMeta.model,
      llmMeta.tokensInput ?? null,
      llmMeta.tokensOutput ?? null,
      llmMeta.latencyMs ?? null,
    ],
  );
  return result.rows[0] || null;
}

/**
 * Get an insight by its week start date (YYYY-MM-DD)
 */
export async function getInsightByWeek(weekStart: string): Promise<ConversationInsightsRecord | null> {
  const result = await query<ConversationInsightsRecord>(
    `SELECT * FROM conversation_insights WHERE week_start = $1`,
    [weekStart],
  );
  return result.rows[0] || null;
}

/**
 * Mark an insight as posted to Slack
 */
export async function markPosted(id: number, channelId: string, messageTs: string): Promise<void> {
  await query(
    `UPDATE conversation_insights
     SET status = 'posted', slack_channel_id = $2, slack_message_ts = $3
     WHERE id = $1`,
    [id, channelId, messageTs],
  );
}

/**
 * Mark an insight as failed
 */
export async function markFailed(id: number): Promise<void> {
  await query(
    `UPDATE conversation_insights SET status = 'failed' WHERE id = $1`,
    [id],
  );
}

/**
 * List recent insights, newest first
 */
export async function listInsights(limit: number = 12): Promise<ConversationInsightsRecord[]> {
  const result = await query<ConversationInsightsRecord>(
    `SELECT * FROM conversation_insights ORDER BY week_start DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}
