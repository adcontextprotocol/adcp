---
"adcontextprotocol": patch
---

Fix worker recovery gap on rolling deploys (#4723). PR #3374 added `auto_start_machines = true` + `min_machines_running = 1` to the worker `[[services]]` block, but per Fly docs those flags are only enforced via fly-proxy — and a `[[services]]` block without `[[services.ports]]` doesn't get fly-proxy routing. The settings were inert. If a rolling deploy left the worker `stopped` (flyctl does not always issue `MachineStart` after `MachineUpdate`), nothing brought it back automatically; the watchdog from PR #4358 observed the failure but couldn't recover. Today's incident at 04:31 UTC required a manual `fly machine start`.

The watchdog now actively recovers: on probe failure it queries the Fly Machines API, finds any worker machines in `stopped` state, and starts them. Started machines surface as a successful probe on the next tick; if start didn't help (real crashloop), failures keep climbing and the alert still fires. Requires `FLY_API_TOKEN` secret on the app — without it, recovery is a no-op and behavior matches PR #4358.

Also corrects the misleading comment block in `fly.toml` that asserted autostart was wired up.
