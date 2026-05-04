---
---

Block `app.listen()` until the training-agent tenant registry is fully initialized.

The previous fix (#4060) only triggered eager init at module load — it didn't gate the HTTP listener on init completing. The 6-tenant registration burst takes 30–60s on a fresh Fly machine; the post-deploy smoke runs at ~T+10s and probes the tenant routes during the warmup window, getting 500s every time. Five consecutive deploys failed the smoke before this PR; production was healthy minutes later in every case.

Fix: `createTrainingAgentRouter()` now returns `{ router, ready }`. `HTTPServer.start()` awaits `ready` before `app.listen()`, so the listener doesn't bind until the registry is actually ready to serve. Real init bugs (#3854, #3869 class) now surface as a boot crash and roll the deploy back, instead of dribbling 500s at users until restart.

API change touches every test that boots the router; updated the 7 callsites under `server/tests/integration/`, `server/tests/manual/`, and `scripts/`.
