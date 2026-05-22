---
---

fix(training-agent): stop adcp-docs crash loop from bare JSON imports

PR #4675 added four bare JSON imports in
`server/src/training-agent/fixtures/verification-walkthrough/index.ts`.
Node 22 ESM rejects JSON imports that don't carry
`with { type: 'json' }`, so the compiled `dist/index.js` threw
`ERR_IMPORT_ATTRIBUTE_MISSING` on boot — both Fly `web` machines hit max
restart count and `adcp-docs.fly.dev` served load-balancer errors for
every request.

`with { type: 'json' }` alone wouldn't compile under the server's
`module: "ES2022"` tsconfig (`TS2823`). To unblock the crash loop
without touching module emission for the whole server, the four fixture
documents are inlined as `as const` object literals in `index.ts` and
the standalone `.json` files are removed. All consumers go through the
`WALKTHROUGH_FIXTURES` export so behavior is unchanged.

Follow-up tracked: revisit `module: ESNext` + `with { type: 'json' }`
so the fixtures can return to being real `.json` files.
