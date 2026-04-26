---
---

Addie: render storyboard `context_value_rejected` hints as a Diagnose / Locate / Fix / Verify build playbook instead of a single passive "Hint:" line. The new formatter consumes the runner's structured hint fields (`source_step_id`, `source_task`, `response_path`, `request_field`, `accepted_values`) and emits a deterministic plan that names the two tools that disagree, offers widen-vs-narrow fix paths, and cites the exact `run_storyboard_step` call to verify the fix. Wired into both `run_storyboard` and `run_storyboard_step` MCP tool outputs.

Bumps `@adcp/client` to `5.17.0` to pick up the runner-side hint emission.
