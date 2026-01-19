---
"adcontextprotocol": patch
---

Fix Addie alert spam and improve content relevance

**Alert deduplication fix:**
The alert query now checks if ANY perspective with the same external_url
has been alerted to a channel, preventing spam from cross-feed duplicates.

**Content relevance improvement:**
Tightened `mentions_agentic` detection to require BOTH agentic AI terms
AND advertising context. This prevents general AI news (e.g., ChatGPT updates)
from being flagged as relevant to our agentic advertising community.
