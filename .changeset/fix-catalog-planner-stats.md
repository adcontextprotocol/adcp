---
"adcontextprotocol": patch
---

fix(db): correct stale catalog planner statistics and debounce health-check alerts.

`catalog_properties` autoanalyze had never run, leaving the planner statistics frozen near zero (~185 rows) while the table actually held 2.27M. With estimates that wrong, Postgres chose nested-loop/sequential-scan plans sized for a tiny table, so queries that scan the catalog/registry tables (brand enrichment, admin audit, registry reads) ran for tens of seconds.

- Add migration 505: aggressive per-table autovacuum/analyze tuning for `catalog_properties`, `catalog_identifiers`, and `registry_requests` so statistics can never drift that far again, plus a one-time `ANALYZE`.
- Debounce the `/health` database probe: a single transient connect timeout during a rolling deploy or Postgres failover no longer pages the error channel; alerting escalates only after consecutive failures. The 503 load-balancer response is unchanged.
