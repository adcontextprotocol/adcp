---
---

fix(admin): preserve auto_provision_hierarchy_enabled_at on flag flip-off; add disabled_at for forensic preservation

Migration 450 nulled `auto_provision_hierarchy_enabled_at` when `auto_provision_brand_hierarchy_children` was flipped off, destroying the forensic record of when the feature was last active. This migration adds `auto_provision_hierarchy_disabled_at TIMESTAMPTZ NULL` and updates the trigger so flip-off sets `disabled_at = NOW()` and preserves `enabled_at` (which the cohort gate in `autoLinkByVerifiedDomain` reads exclusively). A complete `(enabled_at, disabled_at)` pair lets incident response trace the full on/off cycle without losing the original opt-in timestamp. Partial fix for #3466 — IP/user-agent audit enrichment deferred pending compliance decision.
