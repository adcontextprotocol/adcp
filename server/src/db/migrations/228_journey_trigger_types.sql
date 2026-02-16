-- Add event-driven trigger types to journey_stage_history
-- These are fired when working group membership/leadership changes
-- or when content is proposed, triggering journey recomputation.

ALTER TABLE journey_stage_history
  DROP CONSTRAINT IF EXISTS journey_stage_history_trigger_type_check;

ALTER TABLE journey_stage_history
  ADD CONSTRAINT journey_stage_history_trigger_type_check
  CHECK (trigger_type IN (
    'milestone_achieved',
    'milestone_lost',
    'admin_override',
    'recomputation',
    'initial',
    'membership_change',
    'leadership_change',
    'content_contribution'
  ));
