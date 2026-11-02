---
"adcontextprotocol": minor
---

Add the optional, experimental `security_profiles` capability on `get_adcp_capabilities` (feature id `security.profiles`) and the `adcp-prod-security-3.3` profile (#7066). An endpoint that advertises the id commits, on a closed list of spend-committing operations, to:

- signed requests under either signing profile (`adcp/request-signing/v1` or `web-bot-auth`);
- a 15-minute revocation freshness ceiling with T/3 polling and no grace multiplier;
- acts-for checks for the verified signer only;
- governance binding that a signing key alone cannot change;
- least privilege;
- outbound fetch safety;
- downgrade rules that make buyers refuse rather than fall back.

In 3.3, rejecting non-conforming counterparties is a SHOULD and becomes a MUST in 4.0. A per-principal spend ceiling is recommended and is not part of the id. The field is an open string array, so consumers ignore ids they do not recognize, and advertising a profile requires `security.profiles` in `experimental_features`.
