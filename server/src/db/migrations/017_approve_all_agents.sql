-- Approve all pending agents
-- Now that approval is no longer required, approve any existing pending agents

UPDATE registry_entries
SET approval_status = 'approved',
    approved_at = NOW(),
    updated_at = NOW()
WHERE entry_type = 'agent'
  AND approval_status = 'pending';
