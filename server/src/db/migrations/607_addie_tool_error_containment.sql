-- Keep exact operation recovery unchanged. Separately observe validation
-- failures contained by a successful same-agent read and complete answer.
-- NULL preserves the unknown classification of historical/incomplete turns;
-- never retrospectively relabel them as unresolved or infer from prose.
ALTER TABLE addie_chat_experiment_turns
  ADD COLUMN contained_tool_errors INTEGER,
  ADD CONSTRAINT addie_chat_experiment_tool_containment_valid CHECK (
    contained_tool_errors IS NULL OR (
      contained_tool_errors >= 0
      AND contained_tool_errors <= unrecovered_tool_errors
      AND tool_errors IS NOT NULL
      AND recovered_tool_errors + unrecovered_tool_errors = tool_errors
    )
  );

COMMENT ON COLUMN addie_chat_experiment_turns.contained_tool_errors IS
  'Observed validation rejection followed by successful same-agent AdCP read and complete generated answer; not exact recovery or proof of fulfillment. NULL means unclassified. Remaining unresolved errors = unrecovered_tool_errors - contained_tool_errors. Delivery is tracked separately.';
