-- Shadow evaluation index for pending evaluations
-- The shadow evaluator job queries threads by context->>'shadow_eval_status'
CREATE INDEX IF NOT EXISTS idx_addie_threads_shadow_eval_pending
  ON addie_threads ((context->>'shadow_eval_status'))
  WHERE context->>'shadow_eval_status' IN ('pending', 'waiting');
