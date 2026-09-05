-- WorkOS user.deleted must be able to remove the local user row even when the
-- account has accumulated community, certification, portrait, or review data.
--
-- User-owned records follow the account and are deleted. Nullable attribution
-- fields are cleared. Append-only accreditation/admin audit records retain the
-- opaque WorkOS ID but deliberately stop enforcing a live users-row reference.

ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_requester_user_id_fkey,
  ADD CONSTRAINT connections_requester_user_id_fkey
    FOREIGN KEY (requester_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS connections_recipient_user_id_fkey,
  ADD CONSTRAINT connections_recipient_user_id_fkey
    FOREIGN KEY (recipient_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE community_points
  DROP CONSTRAINT IF EXISTS community_points_workos_user_id_fkey,
  ADD CONSTRAINT community_points_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE user_badges
  DROP CONSTRAINT IF EXISTS user_badges_workos_user_id_fkey,
  ADD CONSTRAINT user_badges_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE learner_progress
  DROP CONSTRAINT IF EXISTS learner_progress_workos_user_id_fkey,
  ADD CONSTRAINT learner_progress_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE certification_attempts
  DROP CONSTRAINT IF EXISTS certification_attempts_workos_user_id_fkey,
  ADD CONSTRAINT certification_attempts_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE user_credentials
  DROP CONSTRAINT IF EXISTS user_credentials_workos_user_id_fkey,
  ADD CONSTRAINT user_credentials_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE teaching_checkpoints
  DROP CONSTRAINT IF EXISTS teaching_checkpoints_workos_user_id_fkey,
  ADD CONSTRAINT teaching_checkpoints_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE certification_learner_feedback
  DROP CONSTRAINT IF EXISTS certification_learner_feedback_workos_user_id_fkey,
  ADD CONSTRAINT certification_learner_feedback_workos_user_id_fkey
    FOREIGN KEY (workos_user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

ALTER TABLE member_portraits
  DROP CONSTRAINT IF EXISTS member_portraits_user_id_fkey,
  ADD CONSTRAINT member_portraits_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(workos_user_id) ON DELETE CASCADE;

-- These rows are retained for accreditation/admin audit history. Their opaque
-- user identifier remains useful after the corresponding local account is gone.
ALTER TABLE learner_protocol_updates
  DROP CONSTRAINT IF EXISTS learner_protocol_updates_workos_user_id_fkey,
  DROP CONSTRAINT IF EXISTS learner_protocol_updates_attempt_id_fkey,
  ADD CONSTRAINT learner_protocol_updates_attempt_id_fkey
    FOREIGN KEY (attempt_id) REFERENCES certification_attempts(id) ON DELETE SET NULL;

ALTER TABLE admin_module_completions
  DROP CONSTRAINT IF EXISTS admin_module_completions_workos_user_id_fkey,
  DROP CONSTRAINT IF EXISTS admin_module_completions_teaching_checkpoint_id_fkey,
  ADD CONSTRAINT admin_module_completions_teaching_checkpoint_id_fkey
    FOREIGN KEY (teaching_checkpoint_id) REFERENCES teaching_checkpoints(id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS admin_module_completions_learner_progress_id_fkey,
  ADD CONSTRAINT admin_module_completions_learner_progress_id_fkey
    FOREIGN KEY (learner_progress_id) REFERENCES learner_progress(id) ON DELETE SET NULL;

ALTER TABLE admin_credential_reissue_events
  DROP CONSTRAINT IF EXISTS admin_credential_reissue_events_workos_user_id_fkey;

ALTER TABLE flagged_conversations
  DROP CONSTRAINT IF EXISTS flagged_conversations_reviewed_by_fkey,
  ADD CONSTRAINT flagged_conversations_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES users(workos_user_id) ON DELETE SET NULL;

ALTER TABLE known_media_contacts
  DROP CONSTRAINT IF EXISTS known_media_contacts_added_by_fkey,
  ADD CONSTRAINT known_media_contacts_added_by_fkey
    FOREIGN KEY (added_by) REFERENCES users(workos_user_id) ON DELETE SET NULL;
