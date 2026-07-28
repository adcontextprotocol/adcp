---
"adcontextprotocol": patch
---

Correct the `video_16x9_30s` legacy canonical mapping to retain `16:9` as an aspect ratio instead of projecting it as a 16-by-9-pixel video, and guard future small ratio tokens from the same misclassification.
