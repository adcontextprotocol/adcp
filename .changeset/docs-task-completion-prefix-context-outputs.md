---
---

docs(compliance): document task_completion.<inner> prefix for context_outputs.path

Adds a missing bullet to the storyboard-schema.yaml context_outputs runner-behavior
block explaining the task_completion.<inner> path prefix introduced in adcp-client v6.7
(adcp-client#1426). Documents the polling behavior, the result payload field, and
grading on non-success terminal statuses (failed/canceled/rejected →
capture_path_not_resolvable). No wire format changes; YAML comments only.
