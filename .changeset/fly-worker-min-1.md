---
---

ops(fly): drop worker `min_machines_running` from 2 to 1

Workers run scheduled jobs only — they don't take external traffic, so the HA story is weak. One worker handles the full cron schedule, and brief gaps during rolling deploys (≤60s) are invisible for the kinds of jobs we run (cache sweeps, newsletter triggers, crawlers, member sync). Cuts worker compute roughly in half.

Pairs with `fly scale count worker=1 -a adcp-docs` already applied to production.
