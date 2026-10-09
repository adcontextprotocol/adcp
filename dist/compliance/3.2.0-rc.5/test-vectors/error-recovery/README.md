# Error recovery compatibility vectors

These vectors pin the AdCP 3.2 recovery decision while preserving valid 3.1
wire input. They are intended for buyer SDK and in-house client test suites.

For each vector, consumers:

1. use wire `error.recovery` when present;
2. otherwise use the registered recovery class for a known code;
3. otherwise use the bounded `transient` fallback for an unknown legacy code;
4. classify before looking at `retry_after`; and
5. consume one retry from the caller's bounded budget whenever an automatic
   retry is scheduled.

`retry_after` is a minimum delay, not permission to retry. A legacy finite
fractional value is rounded up to a whole second before clamping to
`[1, 3600]`. Correctable and terminal errors are never automatically retried
merely because they carry a delay.

The shared 3.x JSON Schema intentionally continues to accept an error without
`recovery`. Such an omission is allowed for 3.1 producers (which SHOULD emit
the field) but violates the 3.2 producer requirement (which is MUST). Consumers
still decode both forms so stored 3.1 responses and live older peers remain
compatible.

`producer_conformant` evaluates the negotiated-version obligation and the
registered `buyer_reason` consistency rule in addition to JSON Schema
validity. `schema_valid` records only the shared schema result. Each expected
result also records whether the decision consumes the retry budget and the
next `retries_attempted` count, so an implementation that schedules without
decrementing its bounded budget cannot pass the suite.
