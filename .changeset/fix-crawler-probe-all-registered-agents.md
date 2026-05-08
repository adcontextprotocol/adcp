---
---

Fix registry crawler skipping non-sales registered agents for health/capability snapshots. The periodic crawl now re-fetches all registered agents on every tick instead of capturing only sales agents at startup, so signals/buying/creative agents get probed without a server restart.
