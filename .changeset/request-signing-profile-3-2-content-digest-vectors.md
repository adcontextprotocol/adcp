---
"adcontextprotocol": patch
---

compliance: add 27 AdCP 3.2 request-signing vectors under `test-vectors/request-signing/profile-3.2/`: 10 positives and 17 negatives. They are content-digest-covered versions of the root positive vectors and of the checklist step 2–12 negatives, and each keeps the number and slug of the root vector it mirrors. Before this, 36 of the 40 root vectors signed without `content-digest`, so a verifier advertising `covers_content_digest: "required"` (the only posture a 3.2 signing peer may advertise) could grade almost none of the checklist (adcp#7733). Existing vectors are unchanged. The new vectors come from the committed `scripts/generate-request-signing-profile-3.2-vectors.mjs` and are independently verified in `tests/request-signing-profile-3.2-vectors.test.cjs`. The README now also tells harnesses to reset verifier state between vectors, and the signed-requests test-kit comments note that the stateful contracts cover the 3.2 counterparts.
