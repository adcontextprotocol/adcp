---
---

Drops the unfiltered `/api/storyboards` fallback on the dashboard's storyboard picker. When `/api/registry/agents/:url/applicable-storyboards` returned a generic error (capabilities probe failed for a reason other than the recognized OAuth / needs-auth / unknown-specialism shapes), the dashboard fell back to the unfiltered full storyboard catalog — so a signals-only agent showed pagination-creative-formats, get-media-buys-pagination-integrity, and the rest. Closes #4254. Now: error message stays, but no storyboards render until the agent's `get_adcp_capabilities` returns `supported_protocols` and `specialisms`. OAuth / needs-auth / unknown-specialism error paths are unchanged.
