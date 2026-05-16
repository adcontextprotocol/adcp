---
---

ops(observability): emit `audit_log_insert_failed` PostHog metric when `type_reclassification_log` insert is swallowed

The audit-log insert helper (`server/src/db/type-reclassification-log-db.ts`) intentionally swallows DB errors so observability never blocks a profile save / crawler promote / backfill row write. Until now the only signal of a failed insert was a `warn` log line — fragile to alert on. The catch block now also emits `captureEvent("server-metrics", "audit_log_insert_failed", { source, error_class })`, where `error_class` is the 2-char SQLSTATE class (e.g. `'23'` for integrity violations, `'08'` for connection failures) or `'unknown'` when the thrown error is not a pg error. SREs can now alert on `audit_log_insert_failed > 0 over 5m` and the future audit-log query UI can trust the volume signal. Closes #3574.
