-- Materialized view for actual engagement time (not wall-clock time).
-- Sums inter-message gaps capped at 5 minutes. If a learner walks away for 2 hours,
-- only 5 min of that gap counts. This is the standard approach from web analytics
-- adapted for conversational learning.

CREATE MATERIALIZED VIEW IF NOT EXISTS learner_engagement_time AS
WITH ordered_msgs AS (
  SELECT
    lp.id AS progress_id,
    m.created_at AS msg_at,
    LAG(m.created_at) OVER (
      PARTITION BY lp.id ORDER BY m.sequence_number
    ) AS prev_msg_at,
    m.role
  FROM learner_progress lp
  JOIN addie_threads t ON (t.thread_id::text = lp.addie_thread_id OR t.external_id = lp.addie_thread_id)
  JOIN addie_thread_messages m ON m.thread_id = t.thread_id
  WHERE lp.addie_thread_id IS NOT NULL
)
SELECT
  progress_id,
  -- Engagement: sum of capped gaps (5 min max per gap)
  ROUND(COALESCE(SUM(LEAST(
    EXTRACT(EPOCH FROM (msg_at - prev_msg_at)),
    300
  )) FILTER (WHERE prev_msg_at IS NOT NULL), 0) / 60.0, 1) AS engagement_minutes,
  -- Wall clock: first to last message
  ROUND(COALESCE(EXTRACT(EPOCH FROM (MAX(msg_at) - MIN(msg_at))), 0) / 60.0, 1) AS wall_clock_minutes,
  -- Message counts
  COUNT(*) AS total_messages,
  COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
  COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_messages,
  -- Session count: gap > 30 min = new session (minimum 1)
  1 + COALESCE(COUNT(*) FILTER (
    WHERE prev_msg_at IS NOT NULL
    AND EXTRACT(EPOCH FROM (msg_at - prev_msg_at)) > 1800
  ), 0) AS session_count,
  MIN(msg_at) AS first_message_at,
  MAX(msg_at) AS last_message_at
FROM ordered_msgs
GROUP BY progress_id;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX ON learner_engagement_time(progress_id);
