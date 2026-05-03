---
'adcontextprotocol': patch
---

docs(skill): document the four implementation-dependent `issues[]` fields callers may see

`skills/call-adcp-agent/SKILL.md` already documents the three required `issues[]` fields (`pointer`, `keyword`, `variants`) that every conformant validator surfaces. Adds the four optional fields a calling agent will encounter when the seller's validator opts into them — `discriminator`, `schemaId`, `allowedValues`, `hint` — with a one-line preface clarifying these are implementation-dependent (not every validator emits them) and an updated recovery order: read `hint` first when present, then `discriminator`, then walk `variants`.

Two new rows added to the symptom-fix lookup table for the same fields.

No wire-format change. Pure documentation: shipping these fields is already a valid validator extension; this just gives callers a curated path through them.

Surfaced from the @adcp/sdk side after PR #1283 / #1309 added the fields and PR #1268 / #1361 hit recurring drift between the local SDK skill copy (which already documented them) and the upstream bundle (which didn't). With this merged, the SDK's `npm run sync-schemas` no longer rewrites the file out from under contributors.
