---
---

Tag addie_thread_messages with message_source at write-time (typed, cta_chip, voice, email, unknown). Replaces the stopgap CTA-chip string allowlist in conversation-insights-builder with a column-based filter using IS DISTINCT FROM 'cta_chip' (Refs #3408, Closes #3455).
