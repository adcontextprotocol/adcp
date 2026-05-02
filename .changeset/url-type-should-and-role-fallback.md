---
"adcontextprotocol": patch
---

spec(url-asset): add SHOULD on `url_type`, role-based fallback, and mechanism-vs-purpose clarification (#2986 step 2)

`url_type` was optional with no fallback rule, so a conformant URL asset that omitted it left receivers guessing — buyers would either pick a default mechanism (with bad blast-radius if a clickthrough fired as a pixel) or refuse to render. Two parallel vocabularies (`url-asset-type` mechanism: 3 values; `url-asset-requirements.role` purpose: 6 values) compounded the confusion because the docs treated them as the same thing.

This change:

- Adds a top-level description on `url-asset` stating senders SHOULD include `url_type` on every URL asset, and defining the receiver fallback: when `url_type` is absent, receivers SHOULD fall back to the format's `url-asset-requirements.role` (clickthrough/landing_page → `clickthrough` mechanism; *_tracker roles → `tracker_pixel`); when neither is present, receivers MAY reject rather than guess.
- Updates the `url_type` property description to frame it explicitly as the receiver's invocation mechanism, and points at the role fallback for senders that omit it.
- Updates `url-asset-requirements.role` description to call out the mechanism-vs-purpose distinction (a `click_tracker` slot validly accepts a `tracker_pixel` URL).
- Rewrites `docs/creative/asset-types.mdx` URL Asset section, replacing the old "you only need to supply the `url` value" guidance and the incorrect enum list (`impression_tracker`/`video_tracker`/`landing_page` — those were the requirement-side `role` values, not `url_type` values) with the actual `clickthrough`/`tracker_pixel`/`tracker_script` enum, the SHOULD note, and the role fallback table.

Wire format unchanged. Existing senders that already include `url_type` are unaffected. Senders that omit `url_type` continue to validate but now have explicit receiver semantics; in 4.0 we plan to make `url_type` required (separate change). Closes step 2 of the rollout proposed on adcp#2986.
