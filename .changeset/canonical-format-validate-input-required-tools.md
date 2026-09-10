---
"adcontextprotocol": patch
---

`canonical_format_validate_input` no longer lists `comply_test_controller` in `required_tools`. The storyboard runner's per-storyboard gate admits a storyboard when any listed tool is present, so any agent exposing the (universal) test controller was selected and then failed all 17 steps on the missing `validate_input`. Agents without `validate_input` now receive a coverage-gap skip; agents implementing it run unchanged. Same shape as #6774 (fixes #7404, bug 1).
