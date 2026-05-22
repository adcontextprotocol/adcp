---
"adcontextprotocol": patch
---

Schema bundler: `x-adcp-hoist: true` opt-in marker for canonically shared object schemas. Spec authors set the directive on a source schema's root; the bundler moves the schema to a single root `$defs` entry, replaces every inline occurrence with `$ref`, and strips the directive from bundled output. Opt-in companion to the pure-enum auto-hoist (`hoistDuplicateInlineEnums`), addressing the complex-object case where structural identity ≠ semantic identity (e.g. `BriefAsset` and `VASTAsset` share fields today but represent different lifecycle concepts — auto-hoisting them would lock in coupling the source schemas don't express). No source schemas opt in here; per-type decisions ship in follow-ups. See [Schema Extensions reference](/docs/reference/schema-extensions#x-adcp-hoist) for the directive's contract.
