-- Migration: 126_clarify_peer_triggered_message.sql
-- Clarify the Peer-Triggered variant message to better explain what account linking means
--
-- The previous message assumed readers understood what "linking" means.
-- This update explicitly explains that they have a Slack account and clicking
-- the link will connect it to their web account on agenticadvertising.org.

UPDATE outreach_variants
SET message_template = E'{{user_name}} - I''m reaching out to the {{company_name}} team members who haven''t connected their Slack and web accounts yet.\n\nRight now you have a Slack account with us. Clicking this link will connect it to your agenticadvertising.org web account:\n\n{{link_url}}\n\nOnce connected, you''ll be able to access working group resources, vote in governance, and appear correctly in the member directory.\n\nMost people complete it in under a minute.'
WHERE name = 'Peer-Triggered';
