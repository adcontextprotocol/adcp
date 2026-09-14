---
"adcontextprotocol": patch
---

Retire superseded 3.x beta prerelease artifacts from `dist/schemas`, `dist/compliance`, and `dist/protocol`, keeping only the `3.2.0-beta.11` schema bundle (frozen `3.2-beta` documentation selector), `3.2.0-beta.6` (the training agent's retained checkpoint), and `3.1.0-beta.7` (the TypeScript SDK side bundle). This removes about 2 GB from the repository and the runtime image, whose size gate the rc.3 release branch had started to exceed. Previously published beta URLs continue to be served from the artifact CDN on a best-effort basis; documentation now links to the `3.2.0-rc.2` bundle. The immutable-release-artifact guard now permits whole-tree deletion of tagged beta checkpoints while still rejecting in-place edits and any deletion of release-candidate or stable artifacts.
