---
---

Two corrections from the second live v2 run of the AdCP issue-triage routine:

1. **Already-engaged check.** The bot posted competing flag-for-review comments on issues `#2902` and `#2903`, which the maintainer was actively working on in a Conductor workspace — invisible to GitHub, so the bot thought they were untriaged. Add a check before expert consultation: silent-defer when the issue is assigned to a repo member, has an open PR referencing it, or has a repo-member comment in the last 7 days.

2. **Tighten "never create labels".** The first v2 run ended with a `compliance-suite` label on two issues that had no description — likely bot-created despite the existing rule. Reinforce: the routine must run `gh label list` first and apply only labels whose names appear in the output. If a bucket doesn't have a matching label, put the bucket name in the comment body and flag the gap in the run summary — don't create the label.
