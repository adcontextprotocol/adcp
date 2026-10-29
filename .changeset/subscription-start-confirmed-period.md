---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): the period in which a buy is confirmed is now owed. The start bound is the first boundary at or after the later of the subscription version's `accepted_at` and the account's `authorized_at`. A buy is then owed every period that ends after its `confirmed_at` and overlaps its flight, so a mid-period confirmation owes that period in full.

Before, `confirmed_at` also moved the start to the next boundary. A buy confirmed at 10:00 on its start day, as with ASAP starts, owed nothing for that day on a daily feed. A buy confirmed on November 12 owed nothing for November on a monthly billing feed, so its invoiced spend appeared in no official billing revision. Subscription obligations also disagreed with the account-level ledger, which includes any buy confirmed by a period's end.

A flight whose stop time is at or before its `start_time`, such as a buy canceled before it starts, overlaps no period and owes nothing.
