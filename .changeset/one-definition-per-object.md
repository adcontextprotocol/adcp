---
"adcontextprotocol": patch
---

Every branch of a discriminated union states its tag's value as its `default`. Where a union's branches pin one property to a `const` (or a one-value `enum`), each branch now carries `"default"` equal to that value, beside the `const`. 529 tag properties in 147 unions gain the annotation. A table of `anyOf` value constraints, such as the country and postal-system pairs in `core/postal-country-system.json`, is a guard rather than a tagged union and gets no default. `default` is an annotation, so no payload's validity changes.

209 objects that stand for a concept of their own gain a `title` naming it, so generated types and docs name the concept instead of a path.
