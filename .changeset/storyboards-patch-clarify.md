---
---

patch: clarify that storyboards/conformance-suite changes version independently of spec; deprecate `signed-requests` preview specialism (taxonomy correction)

Two patches in one PR, both clarifications:

**versioning.mdx clarification.** Adds a "Spec changes vs. conformance-suite changes" subsection making explicit that conformance-suite changes (storyboards, specialism taxonomy, scenario classifications, runner mechanics) version independently of spec and are patch-level by default. The release-vs-patch rules in the spec apply to wire-level artifacts under `static/schemas/source/` and normative prose in `docs/`. Storyboards under `static/compliance/source/` and the runner machinery are verification artifacts AAO maintains; they're not the spec. Includes a per-change-type table so authors can size correctly.

**`signed-requests` preview specialism deprecated.** The `signed-requests` specialism YAML at `static/compliance/source/specialisms/signed-requests/index.yaml` is marked `status: deprecated` with an updated narrative explaining the reclassification. The conformance bar is unchanged; only the location moves. Tracked at #3075 (full reclassification to a universal capability-gated storyboard at `static/compliance/source/universal/signed-requests.yaml`, alongside the `request_signing.supported: true` capability advertisement).

Why patch:
- The versioning.mdx change is policy clarification — no normative wire-level requirement changes.
- The signed-requests reclassification is `preview` status with no graded users today; the on-wire seller obligation (advertise `request_signing.supported: true`, implement the verifier per the security profile) is unchanged. Only the conformance runner taxonomy moves.

The full reclassification (file move from `specialisms/` to `universal/`, test-kit refactor at `signed-requests-runner.yaml`, doc cross-reference updates in `release-notes.mdx`, `whats-new-in-v3.mdx`, `prerelease-upgrades.mdx`, `compliance-catalog.mdx`, etc.) ships as a follow-up patch under #3075.
