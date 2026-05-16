---
---

Revert #4062 — blocking `app.listen()` on tenant warmup made Fly's 300s deploy-health-check timeout fire before the listener bound. Deploy failed instead of just the smoke. Restoring the post-#4060 state (eager init at module load, fire-and-forget, listener binds immediately). Smoke still flakes; investigation of the underlying init slowness deferred to a follow-up.
