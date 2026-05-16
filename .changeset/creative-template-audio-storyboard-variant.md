---
---

feat(compliance): add optional audio build phase to creative_template storyboard (#4015)

Audio-creative platforms (TTS services, voice generation agents, mix/master pipelines)
could not pass the `creative_template` storyboard because the existing `build` phase
sends image inputs and expects display-tag output. They validated via manual round-trip
only — no formal compliance signal.

Adds an optional `audio_build` phase with a `build_audio_creative` step that exercises
`build_creative` with audio inputs (`script` and `voice` text assets, `click_url`) and
validates that the output carries a creative manifest with audio assets. Both sync
returns and task-envelope async returns (submitted → working → completed) are valid
under the existing `comply_scenario: creative_flow` gate.

The phase is gated by `skip_if: "!test_kit.supports_audio_formats"`. Display-only
template agents (the majority today) set `supports_audio_formats: false` in the test
kit and the runner grades the phase `not_applicable`. Audio platform adopters flip the
flag to `true`.

Also adds `supports_audio_formats: false` flag and an `assets.audio` sample-content
block to `acme-outdoor.yaml` so audio-enabled test runs have the right fixture material.

No existing steps changed. Non-breaking: additive scenario per the conformance-harness
patch-eligibility rules in `docs/building/conformance.mdx`.
