---
---

Stage 2 of C2PA provenance signing (#2370): wire `signC2PA()` into the illustration generator so every hero image and newsletter cover produced by Gemini carries an embedded C2PA manifest when the feature flag is on.

The manifest declares AAO as the issuer, identifies `gemini-3.1-flash-image-preview` as the software agent, marks the asset as `trainedAlgorithmicMedia` (Art 50 / SB 942 machine-readable disclosure), and carries a SHA-256 of the prompt (not the prompt itself — hero prompts can include author-private visual descriptions). `c2pa_signed_at` and `c2pa_manifest_digest` are persisted alongside the illustration and newsletter-cover rows so admin tooling can distinguish signed from unsigned without parsing every PNG.

Failure policy is env-gated: default returns the unsigned buffer so a transient C2PA failure never blocks a newsletter send, and `C2PA_STRICT=true` converts failures into generation errors for canary rollouts. Every failure fires a throttled system-error alert via `notifySystemError` (one per 5 min per source) so sustained failures surface immediately. Closes #2465.
