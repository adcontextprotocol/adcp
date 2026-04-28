---
---

Surface the CTA-producing context blocks to Addie's reasoning, not just her rules engine. `formatMemberContextForPrompt` now renders sections for `certification`, `agent_testing`, `perspectives`, `next_event`, and `adoption` — five blocks that were hydrated onto MemberContext for the suggested-prompts engine but had been invisible to Addie's system prompt. After this change, when a learner clicks "Continue A1" Addie's system prompt already says "Currently working on: A1 (in progress, started 7 days ago)" instead of forcing a tool round-trip to figure out what they're working on. Same for stale agent tests, upcoming events, the user's perspectives footprint, and missing public company listings.
