---
---

Fix `parsed is not defined` ReferenceError in member profile photo preview. The `parsed` variable was declared with `const` inside a `try` block but referenced outside it; hoisting to `let` before the block resolves the scope error.
