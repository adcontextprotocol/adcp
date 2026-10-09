# External smoke

`npm run test:external-smoke` checks the deployed public test agent using the
hosted compliance artifacts in this checkout. Override `ADCP_SMOKE_CHECK_URL`
and `ADCP_SMOKE_CHECK_TOKEN` for an operator-selected endpoint. This is synthetic
monitoring, not validation of candidate server code or a release gate. The
scheduled/manual `external-smoke.yml` workflow is its only CI caller.

Each authenticated/anonymous probe makes at most two discovery attempts, each
with a fresh AbortSignal and fetch closure, a 10s total
budget, and explicit 4s SDK transport timeout. Only categorized transient
transport failures retry; schema, assertion, auth and unknown errors do not.
Authenticated discovery runs once per attempt and its profile is reused for
local storyboard resolution. Anonymous success meets the same checks, or
failed discovery must supply concrete authentication error evidence.

SDK 14.0.0-rc.35 does not pass the signal to its second capability call. The
local `trustedFetchFn` composes the attempt signal with the transport signal
and rejects new requests after abort, including late SDK calls. Native fetch
aborts in-flight requests and response bodies. A deadline race bounds the
caller, but cannot cancel SDK JavaScript or a custom fetch implementation that
ignores abort; those promises may continue unwinding. SDK connection cache
entries are isolated by fetch identity and may remain until the runner exits.
This test-only trusted fetch uses Node's networking for
operator-selected endpoints; it is not a hosted untrusted-URL security boundary.
