---
---

Close #2849: daily audit backstop for admin-settings channel privacy. #2735 catches drift at send time — a channel that has flipped private → public stops receiving sensitive posts on the first send after the drift. Channels that sit idle between writes could go undetected. This job runs once a day, checks each configured channel (billing / escalation / admin / prospect / error / editorial) against Slack, and emits a structured `channel_privacy_drift_audit` warn/info log on any drift or unverifiable state.

When drift is found, a summary is posted to the `admin_slack_channel` — unless that channel itself is the drifted one, in which case the summary is suppressed and the structured log is the only signal (log aggregation alerting should key on the event). Non-destructive by design: the audit does NOT auto-null the drifted setting. The send-time gate from #2735 already refuses to post sensitive content; this job is pure observability.

Registered with the existing `jobScheduler`, 24-hour interval, 10-minute initial delay. Uses the `runChannelPrivacyAudit()` export as its runner. 9 unit-test scenarios cover the orchestration logic (unconfigured channels skipped, admin-channel self-drift suppresses the summary, throws collapse to 'unknown', non-destructive behavior pinned).
