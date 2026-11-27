---
"adcontextprotocol": patch
---

Stop tracking the compiled `storyboard-runner-options` module at the top level of `dist/compliance/`. It is a build output of `server/src/compliance/`, stale since adcp#8272, and nothing imports the committed copy. The released `dist/compliance/<version>/` bundles are unchanged.
