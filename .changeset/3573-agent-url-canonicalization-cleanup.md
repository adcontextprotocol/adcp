---
---

ops(registry): one-shot cleanup scripts for `agent_url` canonicalization drift (follow-up to #4551 / #3573).

`audit-agent-url-canonicalization-collisions.ts` reports collisions in `agent_registry_metadata` and `member_profiles.agents`. `reconcile-agent-url-canonicalization.ts` merges canonical-collision pairs in the metadata table and dedupes intra-profile JSONB collisions; defaults to dry-run, `--apply` to write. Tested locally against the exact prod duplicate shapes; idempotent on re-run.
