---
---

`/api/registry/operator` accepts an optional `?scope=public|member|private|all` query parameter to opt INTO a specific visibility bucket. `scope` is a narrowing filter — it can never escalate beyond what the caller's auth admits (e.g. `scope=member` from an explorer/anonymous caller silently returns public only; `scope=private` from a non-owner returns empty). Default behavior (no param, or `scope=all`) is unchanged — tier-aware union of public + members_only (API-tier members) + private (profile owner).
