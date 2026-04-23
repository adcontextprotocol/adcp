---
---

Close #2938: fix two stale-state bugs in the Agents dashboard 429 UX introduced with PR #2933.

- **Clear `autoRetriedAgents` on success.** `pageState.autoRetriedAgents` was a session-lifetime `Set` — an agent that hit 429 at 9am and auto-retried once would, on a genuine manual retry at 5pm (long after the rate-limit window closed), render the "refreshed too quickly" copy on the next 429. `retryAgentCard` now deletes the agent's entry from the set in the `try` branch after a successful fetch, so the marker only persists while an auto-retry is actually pending.
- **Re-entry guard on `retryAgentCard`.** If a user clicks Retry at the exact moment the countdown interval enables the button, the click handler and the interval's post-countdown call could race. A `data-retry-in-flight="1"` attribute set on the card at the top of `retryAgentCard` causes concurrent calls to early-return. The flag lives on the DOM so successful retries drop it for free when `card.replaceWith(newCard)` runs; failures clear it in the `catch` branch.

No test changes — `dashboard-agents.html` has no frontend unit harness in this repo, consistent with #2933.
