---
"adcontextprotocol": patch
---

docs(aao-verified): make the two axes truly orthogonal — Live is no longer a downstream of Spec. The prerequisite framing was wrong: a seller without a sandbox/test endpoint (common for SDK-built agents whose wire format is guaranteed by the SDK, or for production-only platforms that have no test-mode surface) can earn (Live) directly by enrolling a compliance account. The eight observability checks already exercise wire format, filters, lifecycle, and scope introspection through real traffic, which makes a separate simulation pass redundant for that seller. Conversely, a test agent earns (Spec) as a complete claim.

Updated copy in `docs/building/aao-verified.mdx`:
- Top-level framing now states the axes are orthogonal, not hierarchical.
- (Live) eligibility table no longer says "Currently holds (Spec)".
- "(Live) only" badge reading is now a normal, valid claim — not a "rare and transient" state.
- Mark semantics list (Live) only as a holding alongside (Spec) only and (Spec + Live).
- Lifecycle: revoking (Spec) no longer revokes (Live); revoking (Live) no longer touches (Spec).

Updated `docs/building/conformance.mdx` to match: both marks attest conformance via different evidence (Spec via simulation, Live via real-traffic observability).

No code changes — the badge model already supported `verification_modes: ['live']` standalone; the only thing that needed fixing was the documentation that incorrectly claimed otherwise.
