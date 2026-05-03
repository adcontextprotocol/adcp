---
"adcontextprotocol": minor
---

Add `sponsored-intelligence` to `AdCPSpecialism` enum as a preview specialism.

The four SI lifecycle tasks (`si_get_offering`, `si_initiate_session`, `si_send_message`, `si_terminate_session`) have been in the spec since 3.0. This change adds the corresponding specialism ID so SDK v6 can define a `SponsoredIntelligencePlatform` interface using the same `RequiredPlatformsFor<S>` dispatch pattern as all other specialisms.

Ships as `status: preview` because the underlying SI schemas carry `x-status: experimental`. The compliance runner produces no stable pass/fail verdict until schemas graduate. Consistent with the preview-specialism pattern established for other experimental surfaces.
