---
"adcontextprotocol": patch
---

Refactor publisher property selector schemas to eliminate duplication. Created shared `publisher-property-selector.json` core schema that is now referenced by both `product.json` and `adagents.json` via `$ref`, replacing duplicated inline definitions.

**Technical improvement**: No API or behavior changes. This is a pure schema refactoring that maintains identical validation semantics while improving maintainability and TypeScript code generation.
