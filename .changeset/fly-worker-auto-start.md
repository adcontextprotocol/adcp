---
---

Fix Fly worker process group lifecycle — rolling deploys were leaving worker
machines in `stopped` state forever because the worker pgroup had no
auto_start_machines path (only `[http_service]` had it, scoped to web).
Replace the bare `[[checks]]` block with a `[[services]]` block targeting
`processes=["worker"]` with `auto_start_machines=true` and
`min_machines_running=2`. No external ports — workers stay private; the
internal_port is only used by the http_check.

Symptom this fixes: the periodic catalog crawler (every 30 min) and the
buying-agents crawler (every 6h) only run on workers. Workers being
stopped meant the property-registry-unification chain (#3274/#3314/#3312/#3352)
was unexercised in production until manual `/api/registry/crawl-request`
calls fired it.
