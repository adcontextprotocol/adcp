---
---

Bump Python uv group dependencies, primarily for `cryptography` 46.0.3 → 46.0.7 which fixes CVE-2026-39892 (buffer overflow via non-contiguous buffers), CVE-2026-34073 (name constraint bypass with wildcard DNS SAN leafs), and a binary-curve key attack. Also bumps `protobuf` 6.33.0 → 6.33.5, `pyasn1` 0.6.1 → 0.6.3, `python-dotenv` 1.2.1 → 1.2.2, `python-multipart` 0.0.20 → 0.0.26, `requests` 2.32.5 → 2.33.0, and `urllib3` 2.5.0 → 2.6.3. Lockfile-only change.
