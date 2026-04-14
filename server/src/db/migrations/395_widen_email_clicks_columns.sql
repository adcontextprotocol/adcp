-- +goose Up
-- Widen email_clicks varchar columns that are too narrow for real-world data.
-- UTM params and link names from marketing tools routinely exceed 100 chars.

ALTER TABLE email_clicks
  ALTER COLUMN link_name      TYPE VARCHAR(500),
  ALTER COLUMN utm_source     TYPE VARCHAR(500),
  ALTER COLUMN utm_medium     TYPE VARCHAR(500),
  ALTER COLUMN utm_campaign   TYPE VARCHAR(500),
  ALTER COLUMN ip_address     TYPE VARCHAR(100);

-- +goose Down
ALTER TABLE email_clicks
  ALTER COLUMN link_name      TYPE VARCHAR(100),
  ALTER COLUMN utm_source     TYPE VARCHAR(100),
  ALTER COLUMN utm_medium     TYPE VARCHAR(100),
  ALTER COLUMN utm_campaign   TYPE VARCHAR(100),
  ALTER COLUMN ip_address     TYPE VARCHAR(50);
