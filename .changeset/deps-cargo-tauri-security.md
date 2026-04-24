---
---

Bump Tauri desktop cargo indirect dependencies for security patches: `bytes` 1.11.0 → 1.11.1 (integer overflow fix in `BytesMut::reserve`) and `time` 0.3.44 → 0.3.47 (RFC 2822 parsing DoS via unbounded recursion). Lockfile-only change under `apps/desktop/src-tauri/`.
