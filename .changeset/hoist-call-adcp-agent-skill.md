---
---

Hoist the `call-adcp-agent` skill from `@adcp/client@5.17.0` into the canonical `skills/` directory of the adcp main repo and make it the cross-SDK source of truth.

- New `skills/call-adcp-agent/SKILL.md` — agent-facing buyer-side wire contract (idempotency replay, account `oneOf` variants, async `status:'submitted'` polling, `adcp_error.issues[]` recovery). Frontmatter declares `adcp_version: "3.x"` and `type: cross-cutting` so the skill loader and SDK consumers can pin compatibility.
- Per-protocol skills (`adcp-{brand,creative,governance,media-buy,si,signals}`) gain a one-line pointer at the top deferring cross-cutting rules to `call-adcp-agent`.
- New `docs/protocol/calling-an-agent.mdx` — human-readable canonical narrative form, registered in both `docs.json` nav configs and cited from the SKILL.md.
- `scripts/build-protocol-tarball.cjs` bundles `skills/` into the published protocol tarball at `adcontextprotocol.org/protocol/<version>.tgz`. SDKs (`@adcp/client`, `adcp` Python, `adcp-go`) already pull this tarball at sync time for schemas and compliance — they get skills for free, version-pinned, Sigstore-verified, no manual copy. `manifest.json.contents.skills` is now an enumerated list so SDK sync scripts can pick out skill names without re-walking the tree.
- `server/src/addie/mcp/adcp-tools.ts` — `loadSkillDocs` is now frontmatter-driven (filters by `name: adcp-*` or `type: cross-cutting`) instead of hardcoding directory names. `resolveSkillsDir` is exported and tries multiple candidate paths so the loader works in dev (`server/src/`), production (`dist/`), and CWD layouts. Cross-cutting rules are consolidated into a single `BUYER_RULES_PREAMBLE` injected at the top of every search response. `call_adcp_task`'s tool description is trimmed to the two non-negotiable rules (`idempotency_key` replay, `issues[].variants[]` recovery). Failure-path output appends a recovery hint pointing at `issues[]`.
- `Dockerfile` copies `/app/skills` into the runtime image and `docker-compose.yml` bind-mounts it for dev iteration. (Previously absent — the skill loader silently returned empty for all `adcp-*` skills in production.)
- `tests/addie/buyer-skill-wiring.test.ts` — 12 new tests locking down the wiring (skill content, frontmatter pin, `resolveSkillsDir` resolution, search preamble injection, tool description shape).
