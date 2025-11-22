---
"adcontextprotocol": patch
---

Simplify format-id schema structure for better code generation compatibility.

**Problem**: The previous schema used a complex `oneOf`/`not`/`anyOf` pattern in `allOf` to express that width/height fields are optional but must appear together. This caused code generators to interpret the schema as two separate types (FormatId1, FormatId2) rather than a single type with optional fields, forcing union types everywhere format_id was used.

**Solution**: Replaced the complex validation pattern with a simpler approach:
- Moved width/height fields directly into the format-id schema properties
- Used JSON Schema `dependencies` keyword to enforce that width and height must appear together
- Maintained identical validation semantics while producing cleaner generated types

**Impact**:
- Code generators now produce a single FormatId type with optional width/height fields
- No breaking changes to the wire format or validation behavior
- Improved developer experience with better TypeScript/Python type hints
- Eliminates need for union types when referencing format_id

**Example generated type (TypeScript)**:
```typescript
// Before: FormatId1 | FormatId2
// After:
interface FormatId {
  agent_url: string;
  id: string;
  width?: number;      // optional, but must have height if present
  height?: number;     // optional, but must have width if present
  duration_ms?: number;
}
```
