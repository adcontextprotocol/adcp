---
---

Test-only: fix flake in `registry-feed.test.ts > combines multiple type filters with OR`. The four assertions in the `type glob filtering` describe block now filter results to this file's actor (`actor.startsWith('test')`) before counting, matching the pattern the file's other tests already use (lines 57, 78). `queryFeed` doesn't expose an actor filter — by design, since actor isn't part of the public feed contract — so the assertion filter is the right surface to add it. Closes #4413.
