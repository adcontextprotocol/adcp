---
---

Close two spec gaps surfaced by end-to-end storyboard testing against `@adcp/client` 5.1.0.

- **`create-media-buy-response.json` now has three branches.** Added a `CreateMediaBuySubmitted` variant — `status: "submitted"` + required `task_id`, optional `message` and advisory `errors` — for async create_media_buy flows such as guaranteed buys awaiting IO signing. The completion artifact still carries `media_buy_id` and `packages`; the submitted envelope forbids both. The Error branch now forbids `status: "submitted"` so the three shapes are strictly disjoint. Sellers that followed the `sales-guaranteed` storyboard narrative previously emitted a response shape the schema rejected, so the specialism's namesake scenario could not pass. Fixes #2420.
- **`right-use` enum adds `ai_generated_image`.** The `brand-rights` storyboard queries `get_rights` with `uses: ["ai_generated_image"]`, but the enum only covered IP-category rights (likeness, voice, endorsement, etc.), so every conformant seller failed Zod validation before the handler ran. Added the value plus an `enumDescriptions` entry clarifying that it filters by output modality rather than by underlying IP type. Fixes #2418.

Neither change is breaking for existing callers. The sync success and error response shapes are unchanged, and no previous `right-use` value is retired.
