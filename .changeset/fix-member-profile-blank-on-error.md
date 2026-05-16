---
---

Fix /member-profile rendering a blank page when the load API call fails. The `showError` helper wrote into `#error-message`, which lives inside the form container that stays `display: none` until a profile loads — so any load-time failure (timeout, 5xx, 403, JS exception in `populateForm`) was invisible. `showError` now routes to the top-level `#error-container` while the form is hidden, and surfaces the underlying error message instead of a generic "please try again".
