---
---

docs(schemas): codegen note on `agent-permission-denied.json` `oneOf` exclusivity.

datamodel-code-generator and quicktype both render the `oneOf {required:[status]} | {required:[reason]}` idiom as a model with both fields `Optional[...]`, not as a tagged union. SDK authors should model both fields as optional, dispatch on whichever is set, and let runtime schema validation enforce exclusivity. One-line addendum to the schema description so codegen consumers don't write a tagged-union branch that never matches.

DX-expert follow-up from #3887.
