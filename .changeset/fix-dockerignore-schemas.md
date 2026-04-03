---
---

Fix broken /schemas/v3/ URLs by adding dist/schemas exception to .dockerignore. PR #1836 added a blanket `dist` exclusion which prevented released schema version directories from being included in the Docker image.
