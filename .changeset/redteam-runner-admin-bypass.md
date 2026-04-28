---
---

Adds an env-gated admin bypass to the Addie redteam runner. When `ADMIN_API_KEY` is set, the runner sends `Authorization: Bearer …` on each request and is treated as admin server-side, skipping the anonymous 50-msg/IP daily limiter and the per-IP anonymous cost cap. Without this, a single 33-scenario run could exhaust the daily IP budget mid-pass and contaminate results with HTTP 429 / cost-cap responses (which contain none of the redteam's marker words and surface as spurious `missing_marker` failures). No-op when the env var is unset, so default behavior is unchanged.
