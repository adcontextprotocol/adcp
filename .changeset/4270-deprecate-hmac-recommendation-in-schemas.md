---
---

schemas(reporting-webhook, auth-scheme): deprecate HMAC-SHA256 recommendation, point at RFC 9421 webhook profile

Two schema-description-only edits, both surgical, no normative change. Surfaces existing `push-notification-config.json` framing at adjacent schemas where SDK authors actually read them.

`reporting-webhook.json` — the `authentication.schemes` description previously said HMAC-SHA256 was "recommended for production". This contradicts `push-notification-config.json` (which marks both Bearer and HMAC-SHA256 as the deprecated legacy fallback, removed in AdCP 4.0). New buyers reading the schema in isolation were being steered toward the legacy on-ramp. Description now mirrors push-notification-config's framing — both schemes deprecated, removed in 4.0, see push-notification-config for the precedence model.

`auth-scheme.json` — the enum's top-level description was silent about deprecation. SDK authors loading the enum in isolation had no signal these were legacy options. Description now states the values are scoped to the legacy `authentication` block and points readers at the RFC 9421 default.

Out of scope (surfaced for maintainer triage):

- `reporting-webhook.json` still has `authentication` in `required: [...]`, which means reporting webhooks have no opt-in path to RFC 9421 today. Mirroring `push-notification-config.json`'s structural shape (auth block optional, omitted = 9421 default) is a separate normative question — filed at #4270 as the broader on-ramp inventory.

Closes the schema-description sub-item of #4270.
