---
"adcontextprotocol": major
---

Rename show/episode to collection/installment for cross-channel clarity. Add installment deadlines, deadline policies, and print-capable creative formats.

Breaking: show→collection, episode→installment across all schemas, enums, and field names (show_id→collection_id, episode_id→installment_id, etc.). Collections gain kind field (series, publication, event_series, rotation) and deadline_policy for lead-time rules. Installments gain optional booking, cancellation, and staged material submission deadlines. Image asset requirements gain physical units (inches/cm/mm), DPI, bleed (uniform or per-side via oneOf), color space, and print file formats (TIFF, PDF, EPS). Format render dimensions support physical units and decimal aspect ratios.
