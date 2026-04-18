---
---

Add lightweight newsletter capture for non-members. Anonymous visitors can now subscribe from the site footer or an inline card at the end of Stories. Submitting an email provisions a lightweight WorkOS user (`emailVerified: false`), sends a branded confirmation email from `hello@updates.agenticadvertising.org`, and — on click of the single-use 24-hour token — flips `marketing_opt_in` to true and lands the visitor on `/welcome-subscribed.html`. Confirm does not create a session; full account access still requires OAuth. Preserves the invariant that every subscriber is a first-class WorkOS account. IP rate-limited (5 subscribes/min, 30 confirms/min) and per-email cooldown (one confirmation email per inbox per 10 min).
