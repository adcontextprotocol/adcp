---
"adcontextprotocol": patch
---

Fix inaccurate vector count in signed-requests-runner.yaml header comment. The comment stated "28 conformance vectors" but the actual set is 40 (12 positive + 28 negative). Updated to reference positive/ and negative/ directories directly — consistent with the storyboard's own pass_criteria wording — so the comment cannot drift as vectors are added.
