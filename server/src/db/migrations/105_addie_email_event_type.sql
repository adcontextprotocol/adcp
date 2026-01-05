-- Add 'email' as a supported event_type for Addie interactions
-- The column is VARCHAR(50) so no schema change needed, just updating the comment

COMMENT ON COLUMN addie_interactions.event_type IS 'Type: assistant_thread, mention, dm, email';
