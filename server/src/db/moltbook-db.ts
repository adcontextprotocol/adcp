/**
 * Database layer for Moltbook integration
 * Tracks Addie's posts and activity on Moltbook
 */

import { query } from './client.js';

// ============== Types ==============

export interface MoltbookPostRecord {
  id: number;
  moltbook_post_id: string | null;
  perspective_id: string | null;
  knowledge_id: number | null;
  title: string;
  content: string | null;
  submolt: string | null;
  url: string | null;
  score: number;
  comment_count: number;
  posted_at: Date;
  created_at: Date;
}

export interface MoltbookActivityRecord {
  id: number;
  activity_type: 'post' | 'comment' | 'upvote' | 'downvote';
  moltbook_id: string | null;
  parent_post_id: string | null;
  content: string | null;
  slack_notified: boolean;
  created_at: Date;
}

export interface CreatePostInput {
  moltbookPostId?: string;
  perspectiveId?: string;
  knowledgeId?: number;
  title: string;
  content?: string;
  submolt?: string;
  url?: string;
}

// ============== Post Operations ==============

/**
 * Record a post that Addie made to Moltbook
 */
export async function recordPost(input: CreatePostInput): Promise<MoltbookPostRecord | null> {
  const result = await query<MoltbookPostRecord>(
    `INSERT INTO moltbook_posts (moltbook_post_id, perspective_id, knowledge_id, title, content, submolt, url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (moltbook_post_id) DO NOTHING
     RETURNING *`,
    [
      input.moltbookPostId || null,
      input.perspectiveId || null,
      input.knowledgeId || null,
      input.title,
      input.content || null,
      input.submolt || null,
      input.url || null,
    ]
  );
  return result.rows[0] || null;
}

/**
 * Check if a knowledge item has already been posted to Moltbook
 */
export async function hasPostedKnowledge(knowledgeId: number): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM moltbook_posts WHERE knowledge_id = $1`,
    [knowledgeId]
  );
  return parseInt(result.rows[0].count) > 0;
}

/**
 * Get knowledge items that haven't been posted to Moltbook yet
 * Returns high-quality curated articles (quality_score >= 4)
 */
export async function getUnpostedArticles(limit = 5): Promise<Array<{
  id: string;
  title: string;
  external_url: string;
  addie_notes: string;
  quality_score: number;
}>> {
  const result = await query<{
    id: number;
    title: string;
    source_url: string;
    addie_notes: string;
    quality_score: number;
  }>(
    `SELECT k.id, k.title, k.source_url, k.addie_notes, k.quality_score
     FROM addie_knowledge k
     LEFT JOIN moltbook_posts mp ON mp.knowledge_id = k.id
     WHERE mp.id IS NULL
       AND k.quality_score >= 4
       AND k.addie_notes IS NOT NULL
       AND k.is_active = TRUE
       AND k.source_url IS NOT NULL
     ORDER BY k.quality_score DESC, k.created_at DESC
     LIMIT $1`,
    [limit]
  );
  // Map to expected return type
  return result.rows.map(row => ({
    id: String(row.id),
    title: row.title,
    external_url: row.source_url,
    addie_notes: row.addie_notes,
    quality_score: row.quality_score,
  }));
}

/**
 * Update a post with the Moltbook ID after it's been created
 */
export async function updatePostMoltbookId(
  postId: number,
  moltbookPostId: string,
  url?: string
): Promise<void> {
  await query(
    `UPDATE moltbook_posts
     SET moltbook_post_id = $2, url = COALESCE($3, url)
     WHERE id = $1`,
    [postId, moltbookPostId, url || null]
  );
}

// ============== Activity Operations ==============

/**
 * Record an activity (post, comment, vote)
 */
export async function recordActivity(
  activityType: 'post' | 'comment' | 'upvote' | 'downvote',
  moltbookId?: string,
  parentPostId?: string,
  content?: string
): Promise<MoltbookActivityRecord> {
  const result = await query<MoltbookActivityRecord>(
    `INSERT INTO moltbook_activity (activity_type, moltbook_id, parent_post_id, content)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [activityType, moltbookId || null, parentPostId || null, content || null]
  );
  return result.rows[0];
}

/**
 * Get recent activity for rate limit checking
 */
export async function getRecentActivity(
  activityType: 'post' | 'comment',
  sinceMinutes: number
): Promise<MoltbookActivityRecord[]> {
  const result = await query<MoltbookActivityRecord>(
    `SELECT * FROM moltbook_activity
     WHERE activity_type = $1
       AND created_at > NOW() - ($2 * INTERVAL '1 minute')
     ORDER BY created_at DESC`,
    [activityType, sinceMinutes]
  );
  return result.rows;
}

/**
 * Get today's comment count for daily limit checking
 */
export async function getTodayCommentCount(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM moltbook_activity
     WHERE activity_type = 'comment'
       AND created_at > CURRENT_DATE`
  );
  return parseInt(result.rows[0].count);
}

/**
 * Check if we can post (respecting 30-minute rate limit)
 */
export async function canPost(): Promise<boolean> {
  const recentPosts = await getRecentActivity('post', 30);
  return recentPosts.length === 0;
}

/**
 * Check if we can comment (respecting 20-second and daily limits)
 */
export async function canComment(): Promise<{ allowed: boolean; reason?: string }> {
  // Check 20-second limit
  const recentComments = await getRecentActivity('comment', 1); // 1 minute window, check timestamps
  if (recentComments.length > 0) {
    const lastComment = recentComments[0];
    const secondsSinceLastComment = (Date.now() - new Date(lastComment.created_at).getTime()) / 1000;
    if (secondsSinceLastComment < 20) {
      return { allowed: false, reason: `Must wait ${Math.ceil(20 - secondsSinceLastComment)} seconds` };
    }
  }

  // Check daily limit (50 comments)
  const todayCount = await getTodayCommentCount();
  if (todayCount >= 50) {
    return { allowed: false, reason: 'Daily comment limit reached (50)' };
  }

  return { allowed: true };
}

/**
 * Get activities that haven't been notified to Slack yet
 */
export async function getUnnotifiedActivities(limit = 10): Promise<MoltbookActivityRecord[]> {
  const result = await query<MoltbookActivityRecord>(
    `SELECT * FROM moltbook_activity
     WHERE NOT slack_notified
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Mark activities as notified to Slack
 */
export async function markActivitiesNotified(activityIds: number[]): Promise<void> {
  if (activityIds.length === 0) return;

  await query(
    `UPDATE moltbook_activity
     SET slack_notified = TRUE
     WHERE id = ANY($1)`,
    [activityIds]
  );
}

// ============== Reply Tracking ==============

/**
 * Get posts where Addie has commented (for checking replies)
 */
export async function getCommentedPosts(limit = 20): Promise<Array<{
  postId: string;
  commentId: string;
  commentedAt: Date;
}>> {
  const result = await query<{
    parent_post_id: string;
    moltbook_id: string;
    created_at: Date;
  }>(
    `SELECT DISTINCT ON (parent_post_id) parent_post_id, moltbook_id, created_at
     FROM moltbook_activity
     WHERE activity_type = 'comment'
       AND parent_post_id IS NOT NULL
       AND moltbook_id IS NOT NULL
     ORDER BY parent_post_id, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    postId: row.parent_post_id,
    commentId: row.moltbook_id,
    commentedAt: row.created_at,
  }));
}

/**
 * Check if Addie has already responded to a specific comment
 */
export async function hasRespondedTo(parentCommentId: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM moltbook_activity
     WHERE activity_type = 'comment'
       AND content LIKE $1`,
    [`%reply_to:${parentCommentId}%`]
  );
  return parseInt(result.rows[0].count) > 0;
}

/**
 * Check if Addie has already voted on a comment or post
 */
export async function hasVotedOn(targetId: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM moltbook_activity
     WHERE activity_type IN ('upvote', 'downvote')
       AND moltbook_id = $1`,
    [targetId]
  );
  return parseInt(result.rows[0].count) > 0;
}

/**
 * Get today's upvote count for daily limit checking
 */
export async function getTodayUpvoteCount(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM moltbook_activity
     WHERE activity_type = 'upvote'
       AND created_at > CURRENT_DATE`
  );
  return parseInt(result.rows[0].count);
}

/**
 * Check if we've already shared a post to Slack (via any activity)
 * This prevents duplicate "interesting thread" notifications
 */
export async function hasSharedToSlack(postId: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM moltbook_activity
     WHERE parent_post_id = $1`,
    [postId]
  );
  return parseInt(result.rows[0].count) > 0;
}

/**
 * Record that we've shared a post to Slack (as interesting, without commenting)
 */
export async function recordSlackShare(postId: string, title: string): Promise<void> {
  await query(
    `INSERT INTO moltbook_activity (activity_type, parent_post_id, content)
     VALUES ('share', $1, $2)
     ON CONFLICT DO NOTHING`,
    [postId, `Shared to Slack: ${title}`]
  );
}

// ============== Stats ==============

/**
 * Get Addie's Moltbook activity stats
 */
export async function getActivityStats(): Promise<{
  totalPosts: number;
  totalComments: number;
  totalUpvotes: number;
  postsToday: number;
  commentsToday: number;
  upvotesToday: number;
}> {
  const result = await query<{
    total_posts: string;
    total_comments: string;
    total_upvotes: string;
    posts_today: string;
    comments_today: string;
    upvotes_today: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE activity_type = 'post') as total_posts,
      COUNT(*) FILTER (WHERE activity_type = 'comment') as total_comments,
      COUNT(*) FILTER (WHERE activity_type = 'upvote') as total_upvotes,
      COUNT(*) FILTER (WHERE activity_type = 'post' AND created_at > CURRENT_DATE) as posts_today,
      COUNT(*) FILTER (WHERE activity_type = 'comment' AND created_at > CURRENT_DATE) as comments_today,
      COUNT(*) FILTER (WHERE activity_type = 'upvote' AND created_at > CURRENT_DATE) as upvotes_today
    FROM moltbook_activity
  `);

  const row = result.rows[0];
  return {
    totalPosts: parseInt(row.total_posts),
    totalComments: parseInt(row.total_comments),
    totalUpvotes: parseInt(row.total_upvotes),
    postsToday: parseInt(row.posts_today),
    commentsToday: parseInt(row.comments_today),
    upvotesToday: parseInt(row.upvotes_today),
  };
}

// ============== Decision Logging ==============

export type DecisionType = 'relevance' | 'comment' | 'upvote' | 'reply' | 'share';
export type DecisionOutcome = 'engaged' | 'skipped';
export type DecisionMethod = 'llm' | 'rule' | 'rate_limit';

export interface MoltbookDecisionInput {
  moltbookPostId: string;
  postTitle?: string;
  postAuthor?: string;
  decisionType: DecisionType;
  outcome: DecisionOutcome;
  reason: string;
  decisionMethod: DecisionMethod;
  generatedContent?: string;
  contentPosted?: boolean;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
  jobRunId?: string;
}

export interface MoltbookDecisionRecord {
  id: number;
  moltbook_post_id: string;
  post_title: string | null;
  post_author: string | null;
  decision_type: DecisionType;
  outcome: DecisionOutcome;
  reason: string;
  decision_method: DecisionMethod;
  generated_content: string | null;
  content_posted: boolean;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  latency_ms: number | null;
  job_run_id: string | null;
  created_at: Date;
}

/**
 * Record a decision about a Moltbook post
 */
export async function recordDecision(input: MoltbookDecisionInput): Promise<MoltbookDecisionRecord> {
  const result = await query<MoltbookDecisionRecord>(
    `INSERT INTO moltbook_decisions (
      moltbook_post_id, post_title, post_author, decision_type, outcome,
      reason, decision_method, generated_content, content_posted,
      model, tokens_input, tokens_output, latency_ms, job_run_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      input.moltbookPostId,
      input.postTitle || null,
      input.postAuthor || null,
      input.decisionType,
      input.outcome,
      input.reason,
      input.decisionMethod,
      input.generatedContent || null,
      input.contentPosted ?? false,
      input.model || null,
      input.tokensInput || null,
      input.tokensOutput || null,
      input.latencyMs || null,
      input.jobRunId || null,
    ]
  );
  return result.rows[0];
}

/**
 * Get recent decisions for admin UI
 */
export async function getRecentDecisions(options: {
  limit?: number;
  offset?: number;
  decisionType?: DecisionType;
  outcome?: DecisionOutcome;
}): Promise<MoltbookDecisionRecord[]> {
  const { limit = 50, offset = 0, decisionType, outcome } = options;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (decisionType) {
    whereClause += ` AND decision_type = $${paramIndex++}`;
    params.push(decisionType);
  }
  if (outcome) {
    whereClause += ` AND outcome = $${paramIndex++}`;
    params.push(outcome);
  }

  params.push(limit, offset);

  const result = await query<MoltbookDecisionRecord>(
    `SELECT * FROM moltbook_decisions
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );
  return result.rows;
}

/**
 * Get decision statistics for admin dashboard
 */
export async function getDecisionStats(days = 7): Promise<{
  total: number;
  byType: Record<string, { engaged: number; skipped: number }>;
  byMethod: Record<string, number>;
  avgLatencyMs: number;
}> {
  const result = await query<{
    decision_type: string;
    outcome: string;
    decision_method: string;
    count: string;
    avg_latency: string | null;
  }>(`
    SELECT
      decision_type,
      outcome,
      decision_method,
      COUNT(*) as count,
      ROUND(AVG(latency_ms), 0) as avg_latency
    FROM moltbook_decisions
    WHERE created_at > NOW() - ($1 * INTERVAL '1 day')
    GROUP BY decision_type, outcome, decision_method
  `, [days]);

  const byType: Record<string, { engaged: number; skipped: number }> = {};
  const byMethod: Record<string, number> = {};
  let total = 0;
  let totalLatency = 0;
  let latencyCount = 0;

  for (const row of result.rows) {
    const count = parseInt(row.count);
    total += count;

    if (!byType[row.decision_type]) {
      byType[row.decision_type] = { engaged: 0, skipped: 0 };
    }
    byType[row.decision_type][row.outcome as 'engaged' | 'skipped'] += count;

    byMethod[row.decision_method] = (byMethod[row.decision_method] || 0) + count;

    if (row.avg_latency) {
      totalLatency += parseFloat(row.avg_latency) * count;
      latencyCount += count;
    }
  }

  return {
    total,
    byType,
    byMethod,
    avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
  };
}

/**
 * Get recent activity with linked decisions
 */
export async function getRecentActivityWithDecisions(limit = 50): Promise<Array<
  MoltbookActivityRecord & {
    decisions?: Array<{
      decision_type: DecisionType;
      outcome: DecisionOutcome;
      reason: string;
    }>;
  }
>> {
  // Get recent activity
  const activityResult = await query<MoltbookActivityRecord>(
    `SELECT * FROM moltbook_activity
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );

  if (activityResult.rows.length === 0) {
    return [];
  }

  // Get the post IDs to fetch related decisions
  const postIds = activityResult.rows
    .map(a => a.parent_post_id)
    .filter((id): id is string => id !== null);

  if (postIds.length === 0) {
    return activityResult.rows;
  }

  // Fetch decisions for these posts
  const decisionsResult = await query<{
    moltbook_post_id: string;
    decision_type: DecisionType;
    outcome: DecisionOutcome;
    reason: string;
  }>(
    `SELECT moltbook_post_id, decision_type, outcome, reason
     FROM moltbook_decisions
     WHERE moltbook_post_id = ANY($1)
     ORDER BY created_at DESC`,
    [postIds]
  );

  // Group decisions by post ID
  const decisionsByPost = new Map<string, Array<{
    decision_type: DecisionType;
    outcome: DecisionOutcome;
    reason: string;
  }>>();
  for (const d of decisionsResult.rows) {
    if (!decisionsByPost.has(d.moltbook_post_id)) {
      decisionsByPost.set(d.moltbook_post_id, []);
    }
    decisionsByPost.get(d.moltbook_post_id)!.push({
      decision_type: d.decision_type,
      outcome: d.outcome,
      reason: d.reason,
    });
  }

  // Combine activity with decisions
  return activityResult.rows.map(activity => ({
    ...activity,
    decisions: activity.parent_post_id
      ? decisionsByPost.get(activity.parent_post_id)
      : undefined,
  }));
}
