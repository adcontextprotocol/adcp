---
"adcontextprotocol": patch
---

Release tooling: forward merges from the 3.0, 3.1 and 3.2 maintenance lines into main no longer drop main's own release records. `CHANGELOG.md` keeps main's file and inserts each maintenance release block it lacks, in semver order. `static/compliance/published-versions.json` takes the union of both lines' registered versions. `dist/schemas/index.json` and `latest.json` are regenerated from the merged release directories after every merge. Before this, the workflows took the maintenance copies wholesale, which would have deleted main's `3.3.0-beta.0` changelog section and schema-discovery entry at 3.2.6. `scripts/build-schemas.cjs` now exports `writeRootSchemaDiscovery` for the resolver.
