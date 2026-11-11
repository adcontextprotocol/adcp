-- Record which background each hosted logo is drawn for, derived from its
-- rendered pixels, so registry reads can tell a white-ink logo (for dark
-- backgrounds) from a coloured one (for light backgrounds).
--
-- derived_background is a pure function of the stored bytes. It never replaces
-- a background the brand declares (a logo's brand.json `background` field or a
-- light-bg/dark-bg/transparent-bg tag); readers apply it only where none is.
--
-- background_derived_at records that classification ran, so a logo that cannot
-- be classified (an ICO, a blank image) keeps a NULL derived_background and is
-- not retried forever. Rows inserted before this migration have both NULL; the
-- brand-logo-background-backfill job classifies them in small batches.

ALTER TABLE brand_logos
  ADD COLUMN IF NOT EXISTS derived_background TEXT
    CHECK (derived_background IN ('light-bg', 'dark-bg')),
  ADD COLUMN IF NOT EXISTS background_derived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_brand_logos_background_pending
  ON brand_logos (created_at)
  WHERE background_derived_at IS NULL AND review_status IN ('pending', 'approved');

COMMENT ON COLUMN brand_logos.derived_background IS
  'Background this logo is drawn for, from the luminance of its rendered pixels: light-bg (mostly dark ink) or dark-bg (mostly light ink). NULL when not yet classified or unclassifiable; see background_derived_at.';
COMMENT ON COLUMN brand_logos.background_derived_at IS
  'When derived_background was computed. NULL means the backfill job has not classified this row yet.';
