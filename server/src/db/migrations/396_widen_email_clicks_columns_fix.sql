-- Re-apply column widening for email_clicks.
-- Migration 395 included goose Up/Down directives that this custom runner
-- executed as plain SQL, causing the Down block to immediately revert the
-- widening within the same transaction.

ALTER TABLE email_clicks
  ALTER COLUMN link_name      TYPE VARCHAR(500),
  ALTER COLUMN utm_source     TYPE VARCHAR(500),
  ALTER COLUMN utm_medium     TYPE VARCHAR(500),
  ALTER COLUMN utm_campaign   TYPE VARCHAR(500),
  ALTER COLUMN ip_address     TYPE VARCHAR(100);
