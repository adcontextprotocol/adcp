---
"adcontextprotocol": patch
---

Document canonical A2A response structure with comprehensive, consolidated protocol guidance. Clarifies that AdCP responses transmitted over A2A protocol MUST include at least one DataPart containing the task response payload, MAY include TextPart for human messages, and MUST use the last DataPart as authoritative when multiple data parts exist.

**New documentation:**
- `/docs/protocols/a2a-response-format.mdx` - Canonical format specification (consolidated from 657 to 470 lines)
- Updated `/docs/protocols/a2a-guide.mdx` - Streamlined response section, removed redundant extraction code

**Core requirements:**
- MUST include at least one DataPart (even for empty results)
- SHOULD use single artifact with multiple parts (not multiple artifacts)
- Last DataPart is authoritative when multiple exist (AdCP-specific convention)
- Framework wrappers nesting AdCP responses are NOT permitted
- Protocol-level failures (auth, invalid params) use `status: "failed"`
- Task-level failures (platform authorization, partial data) use `errors` array with `status: "completed"`

**Documentation improvements:**
- Consolidated "last data part" explanation (previously explained 3 times, now in one location)
- Removed redundant response extraction code from a2a-guide.mdx (28 lines saved)
- Collapsed detailed examples into expandable `<details>` blocks
- Simplified webhook section (references Core Concepts for authentication/retry)
- Removed trivial "empty results" section (moved to checklist)
- Simplified multiple artifacts guidance
- Clear protocol vs task error distinction with examples
- Progressive disclosure pattern for advanced topics
- Tight cross-referencing between guide (integration) and format spec (canonical structure)
