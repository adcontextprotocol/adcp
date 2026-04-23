---
---

Two admin-channel errors fixed:

- `updateThreadTitle` truncates titles to 500 chars so generated titles can't overflow `addie_threads.title VARCHAR(500)`.
- `/brand/:id/brand.json` rejects non-UUID ids with a 404 instead of letting Postgres throw a 500 on malformed input (e.g. `abc123`).
