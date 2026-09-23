-- Separate pre-provider preparation from provider/tool latency and retain
-- content-free tool recovery outcomes for the Gemini Direct experiment.
ALTER TABLE addie_chat_experiment_turns
  ADD COLUMN relationship_analytics_schedule_ms INTEGER,
  ADD COLUMN relationship_analytics_processing_ms INTEGER,
  ADD COLUMN relationship_analytics_outcome TEXT,
  ADD COLUMN member_context_ms INTEGER,
  ADD COLUMN workos_context_ms INTEGER,
  ADD COLUMN experiment_routing_ms INTEGER,
  ADD COLUMN pre_provider_ms INTEGER,
  ADD COLUMN provider_ms INTEGER,
  ADD COLUMN tool_ms INTEGER,
  ADD COLUMN persistence_delivery_ms INTEGER,
  ADD COLUMN recovered_tool_errors INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN unrecovered_tool_errors INTEGER NOT NULL DEFAULT 0;

ALTER TABLE addie_chat_experiment_turns
  ADD CONSTRAINT addie_chat_experiment_stage_timings_nonnegative CHECK (
    (relationship_analytics_schedule_ms IS NULL OR relationship_analytics_schedule_ms >= 0)
    AND (relationship_analytics_processing_ms IS NULL OR relationship_analytics_processing_ms >= 0)
    AND (member_context_ms IS NULL OR member_context_ms >= 0)
    AND (workos_context_ms IS NULL OR workos_context_ms >= 0)
    AND (experiment_routing_ms IS NULL OR experiment_routing_ms >= 0)
    AND (pre_provider_ms IS NULL OR pre_provider_ms >= 0)
    AND (provider_ms IS NULL OR provider_ms >= 0)
    AND (tool_ms IS NULL OR tool_ms >= 0)
    AND (persistence_delivery_ms IS NULL OR persistence_delivery_ms >= 0)
  ),
  ADD CONSTRAINT addie_chat_experiment_relationship_outcome_check CHECK (
    relationship_analytics_outcome IS NULL
    OR relationship_analytics_outcome IN ('completed', 'failed')
  ),
  ADD CONSTRAINT addie_chat_experiment_tool_recovery_nonnegative CHECK (
    recovered_tool_errors >= 0 AND unrecovered_tool_errors >= 0
  );
