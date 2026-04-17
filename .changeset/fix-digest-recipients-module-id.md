---
---

Fix crash in `getDigestEmailRecipients` — `certification_modules` has neither a `module_id` column nor an `is_active` column. Count capstone modules (`format = 'capstone'`) to match the per-capstone semantics of `cert_modules_completed` (which counts completed `certification_attempts`).
