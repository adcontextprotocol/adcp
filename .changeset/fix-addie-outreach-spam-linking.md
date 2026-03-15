---
---

Fix Addie spamming users with duplicate outreach messages and missing email auto-link on login.
Two bugs fixed:
- **Spam**: With 2 Fly.io instances running, both could pass the rate limit check simultaneously before either updated `last_outreach_at`. Now the claim is atomic (UPDATE ... WHERE within rate limit window) so only one instance wins.
- **Not linked**: Email-based auto-link only ran on `user.created` webhook. Users who joined Slack after signing up, or whose webhook failed, were never retried. Now also runs on every login.
