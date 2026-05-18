---
"adcontextprotocol": patch
---

Correct misleading comment in `fly.toml` for the worker `[[services]]` block. The block was introduced in PR #3374 with `auto_start_machines = true` + `min_machines_running = 1`, and the comment claimed this opted the worker into Fly's autostart lifecycle. Per Fly docs, those flags are only enforced via fly-proxy, and a `[[services]]` block without `[[services.ports]]` doesn't get fly-proxy routing — so both settings are inert. The block still serves a purpose (it attaches the http_check), but the autostart claim was wrong. The actual recovery gap is tracked in #4723. Comment-only change; no behavior delta.
