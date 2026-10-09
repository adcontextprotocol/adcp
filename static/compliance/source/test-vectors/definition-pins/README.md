# Definition pin vectors

Normative vectors for definition pins
([specification](/docs/media-buy/specification#definition-pins)). A pin's
`content_digest` is the lowercase-hex SHA-256 of the RFC 8785 (JCS)
serialization of a closed projection of a third-party-published definition.
The projection rules cannot change without invalidating every existing pin, so
they are published here as data rather than prose.

`vectors.json` contains:

- **`projection_rules`**: per `ref_kind`, the top-level members removed from
  the published entry (`exclude`), the named set arrays (`set_arrays`), and any
  nested array whose elements are projected with another kind's rules
  (`nested`). Exclusion applies to top-level members of the entry only, and to
  top-level members of each nested element; deeper members stay verbatim.
- **`projection_vectors`**: a published entry, its projection, the exact JCS
  bytes, and the digest.
- **`equivalence_vectors`**: pairs of entries that MUST or MUST NOT produce the
  same digest. A rename, new `ext`, rolled `season`, or reordered set array is
  not drift; a `content_rating`, `params`, `status`, or unnamed-member change
  is.
- **`non_ijson_vectors`**: raw published text that has no JCS form, or that
  does and must resolve.
- **`pin_ordering_vector`**: the canonical order of `definition_pins[]`.
- **`collection_mutation_vector`**: a committed proposal whose `terms_digest`
  still verifies after the pinned collection changes, while the pin fails and
  `accept_proposal` returns `REFERENCE_DEFINITION_CHANGED`.

## Algorithm

1. Take the published entry exactly as parsed from the publisher's
   `adagents.json`. Apply no schema defaults; absent and `null` stay distinct.
   Hash every own member, including one named `__proto__`. An entry that is not
   I-JSON (lone surrogate, integer beyond 2^53 − 1) is unresolvable, which is
   drift (`non_ijson_vectors`).
2. Remove the top-level members named in the kind's `exclude` list.
3. For each present `set_arrays` member, de-duplicate by JCS bytes and sort
   ascending by the UTF-8 bytes of each element's JCS serialization. Elements
   of a `nested` array are projected with the named kind's rules first, then
   de-duplicated and sorted the same way.
4. Serialize with JCS, hash the UTF-8 bytes with SHA-256, and encode as
   lowercase hex.

Members the AdCP schemas do not name remain in the preimage, so publishers
keep non-material metadata in `ext`.

`tests/helpers/reference-definition-pin.cjs` is the reference implementation and
`tests/definition-pin-vectors.test.cjs` replays every vector.
