# Collection copies vectors

Reference verdicts for experimental collection copies: the seller's copy of a
collection card that
[`include_collections`](/docs/media-buy/product-discovery/collections-and-installments#collections-in-responses)
(feature id `media_buy.collection_cards`) and
[`list_collections`](/docs/media-buy/task-reference/list_collections)
(feature id `media_buy.collection_catalog`) return, and the
`collection_card.*` and `collection_catalog.bulk_change` webhooks that push it.
Like the features, these vectors are experimental and change with them.

There is no storyboard for `list_collections` or the card webhooks yet; those
wait for training-agent support (#8181). These vectors let buyer SDKs, seller
test suites, and graders check the same rules against frozen inputs in the
meantime, before any agent emits the events.

`vectors.json` contains:

- **`conventions`**: the key, declarations and resolved authorization, the
  closed list of fields a copy wins on, how followers map to declared
  distribution entries, merged statuses, selector and filter matching
  (including RFC 4647 language ranges), completeness, token scope, the 3.3
  version gate, and mirror application.
- **`fixtures`**: the publisher declarations, the selectors the selling
  agent is authorized for, and the seller's card catalog with visibility. A
  vector uses these unless it carries its own.
- **`violation_codes`**: every rule a response or webhook vector can break.
- **`merge_vectors`**: the keys the buyer resolves and the copies from one
  response. `expected.cards` is the buyer's merged view per key.
- **`response_vectors`**: one `list_collections` request, the scope of any presented token, and the
  seller's `response` or task-level `task_error`.
- **`webhook_vectors`**: the seller's declarations, the subscription, the
  keys the subscriber's account can see, and one webhook.
- **`mirror_vectors`**: a mirror's stored version, last applied event and
  cards, and a sequence of webhook deliveries. `expected` is the verdict
  (`applied`, `repair_conditional` with the token to send, or `repair_full`)
  and the mirror when application stops.

Response and webhook vectors list every code the input breaks in
`expected.violations`. An empty list means conformant.

| Case | What it checks |
|---|---|
| `merged_view` | A verified copy wins only on `images`, `sample_content`, `url`, `description`, `season`, `cadence` and the corresponding entry's `distribution[].followers`, and a field it omits keeps the declared value. A copy of an undeclared collection, or from an agent `adagents.json` does not authorize, is display-only. A duplicated key is unresolvable and falls back to `adagents.json`, as does an omitted key. Strays are ignored. Only declared collections are carriage-eligible. |
| `seller_response` | Selector and filter adherence, silent omission of unknown and invisible keys (no per-key error), visibility by account, one entry per key, the same copy as `include_collections`, token scope with set semantics and the cursor excluded, `unchanged` without `collections`, `cache_scope: "public"` without an account, the 100-ID limit, the 3.3 version gate, and both feature ids. |
| `webhook_payload` | `notification_id` equals `event_id` and `notification_type` equals `event_type`, `cache_scope` equals `applies_to.scope`, `updated` carries a full card with `publisher_domain`, `removed` carries the key and no card, bulk carries no cards and no `affected_entity_type`, a card event without `applies_to` is invalid, registry `collection.*` names are not seller events, declared and subscribed types, the registering account, and no card pushed to an account that cannot see it. |
| `mirror_application` | In-order application, upsert of an unseen key, an optional `previous_wholesale_feed_version`, gaps (repair with the last applied version, never the webhook's), out-of-order arrival by UUID v7, bulk change (full replace), retried deliveries and re-emissions applied once, and a failed signature. |

## Grading

1. Validate the vector's request, response or task error, webhook, copies,
   and declarations against their schemas. If any fails, report only
   `schema_invalid`.
2. For a merge vector, resolve each key: count its copies, look up the
   declaration, and check the resolved authorization. Overlay the closed list
   only for a verified copy.
3. For a response vector, check the feature ids, then the version gate, then
   the ID limit. A task error is conformant only where those rules call for
   one. For `unchanged`, compare the presented token's scope with the
   request's. For `listed`, check every entry against visibility, the
   catalog copy, selectors and filters, then completeness when the page is
   both first and last.
4. For a webhook vector, check identity, declarations, subscription, account,
   and visibility.
5. For a mirror vector, apply deliveries in order under the `mirror`
   convention and stop at the first repair.

These vectors do not resolve `authorized_agents` from a full `adagents.json`
(the resolved selectors are given), grade multi-page walks or the
pagination-restart rule, or cover account-scoped overlays in a mirror.

`tests/collection-copies-vectors.test.cjs` contains the reference grader and
replays every vector.
