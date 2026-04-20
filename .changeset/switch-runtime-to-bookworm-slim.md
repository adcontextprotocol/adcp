---
---

Switch Docker base image from `node:22-alpine` (musl) to `node:22-bookworm-slim` (glibc) for the builder and runtime stages, pinned by digest. The repos cloner stage stays on Alpine since it only needs `git`.

Unblocks native dependencies that ship glibc-only prebuilds — notably the C2PA signing libraries for AI-generated imagery (portraits, hero illustrations, docs storyboards) tracked in #2370. Also installs `unzip` explicitly for the Tranco ingestion path (previously satisfied by busybox on Alpine) and pins `TZ=UTC` so time math does not drift with container defaults.
