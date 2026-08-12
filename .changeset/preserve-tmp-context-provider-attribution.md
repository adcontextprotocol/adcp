---
"adcontextprotocol": minor
---

Preserve Trusted Match Context targeting key-values in router-authored, provider-attributed buckets.

**Migration for experimental TMP adopters:** provider-to-router responses continue
to use `signals.targeting_kvs`. Router-to-publisher responses that previously used
`signals.targeting_kvs: [{ "key": "category", "value": "sports" }]` must instead
preserve attribution as `signals_by_provider[provider_id].targeting_kvs: [{ "key":
"category", "value": "sports" }]` and validate that hop against
`context-match-response.json`. The flattened router field is removed rather than
accepted as an alias because it loses the provider identity required for safe
publisher mapping.

This breaking change to the experimental `trusted_match.core` surface was
[announced in #6252](https://github.com/adcontextprotocol/adcp/issues/6252) on
August 6, 2026. Under the [experimental-surface notice
contract](https://adcontextprotocol.org/docs/reference/experimental-status), it
must not appear in a release before September 17, 2026.
