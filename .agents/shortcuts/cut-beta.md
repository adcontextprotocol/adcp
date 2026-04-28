# Cut a 3.1.0-beta.N Release (and Exit Pre Mode for 3.1.0 Stable)

Runbook for cutting beta releases while `main` is in pre mode, and for exiting pre mode when 3.1.0 stable is ready.

## Pre mode

`main` is in pre mode while `.changeset/pre.json` exists. Every Version Packages cut produces `3.1.0-beta.N` instead of `3.1.0`. This is a deliberate safety net: if a `minor` changeset slips into `main` accidentally, it ships as a beta drop, not as 3.1.0 stable.

## Cutting a 3.1.0-beta.N

Routine — same flow as a normal release, just with the beta version number.

1. Land minor (or patch) changesets on `main` via normal PR flow.
2. `release.yml` updates the Version Packages PR. Title shows `Version Packages` and body lists `adcontextprotocol@3.1.0-beta.N`.
3. Required CI checks may not fire (see #3417). Push from a human identity or admin-merge.
4. Merging tags `v3.1.0-beta.N`, creates the GitHub Release, publishes `/protocol/3.1.0-beta.N.tgz`.
5. Trigger `release-docs.yml` manually until #3417 lands:
   ```bash
   gh api repos/adcontextprotocol/adcp/actions/workflows/release-docs.yml/dispatches \
     -X POST -f ref=main -f 'inputs[version]=3.1.0-beta.N'
   ```

`release-docs.yml`'s docs.json updater collapses prerelease versions into a single `3.1-beta` label, so the live docs site shows the latest beta at the `3.1-beta` version selector. The `dist/docs/3.1.0-beta.{N-1}/` directory accumulates in git but isn't linked — periodic cleanup is fine.

## Curated release notes during the beta cycle

The auto-generated CHANGELOG.md gets a `## 3.1.0-beta.N` block per cut. The curated narrative belongs in `docs/reference/release-notes.mdx` — a single `## Version 3.1.0` section that gets updated as betas drop, with the final stable cut as the "what shipped" snapshot.

While in beta, that section can carry a `**Status:** Beta — in development` banner. Update it when betas land if material changes warrant calling out.

## Exiting pre mode for 3.1.0 stable

When 3.1.0 is feature-complete:

```bash
git checkout -b bokelley/exit-pre-3-1-0 origin/main
npx changeset pre exit       # deletes .changeset/pre.json
git add -A
git commit -m "chore(release): exit pre mode for 3.1.0 stable cut"
git push -u origin bokelley/exit-pre-3-1-0
gh pr create --base main --title "chore(release): exit pre mode for 3.1.0 stable" --body "Exits pre mode. Next Version Packages cut produces 3.1.0 stable. See \`.agents/shortcuts/cut-beta.md\` § Exiting pre mode."
```

Land the exit PR. The next Version Packages cut (any new changesets on main, or a manual workflow_dispatch on `release.yml`) produces `3.1.0` stable.

### CHANGELOG.md at exit time

When you exit pre mode, the CHANGELOG.md ends up looking like:

```
## 3.1.0    ← final stable cut, only contains changesets added since the last beta
## 3.1.0-beta.5
## 3.1.0-beta.4
…
## 3.1.0-beta.0
## 3.0.1
```

The `3.1.0` block doesn't aggregate everything since `3.0.0` — each beta consumed its own changeset slice. The "what shipped in 3.1.0 vs 3.0.0" story belongs in `docs/reference/release-notes.mdx`, not CHANGELOG.md. Same convention as 3.0.0/3.0.1.

## Verification checklist (3.1.0 stable cut)

- [ ] `package.json` on `main` is `3.1.0` (no `-beta`)
- [ ] `.changeset/pre.json` deleted
- [ ] Tag `v3.1.0` pushed; GitHub Release marked latest, non-prerelease
- [ ] Release body references cosign verification + SHA-256
- [ ] 4 artifacts attached: `.tgz`, `.tgz.crt`, `.tgz.sha256`, `.tgz.sig`
- [ ] `release-docs.yml` ran (snapshots `docs/` into `dist/docs/3.1.0/`)
- [ ] `docs.json` updated — `3.1` is now a stable version (not `3.1-beta`)
- [ ] `https://adcontextprotocol.org/protocol/3.1.0.tgz` serves
- [ ] `https://adcontextprotocol.org/protocol/` listing shows `3.1.0` in `versions[]`
- [ ] `release-notes.mdx` curated `## Version 3.1.0` section written
- [ ] No duplicate `## 3.1.0` header in CHANGELOG.md
- [ ] Forward-merge from `3.0.x` to `main` is current (no pending forward-merge PR)

## Announcements (3.1.0 stable cut)

- [ ] The Prompt newsletter pickup
- [ ] Slack announcement (#announcements + #adcp-community)
- [ ] LinkedIn post on AAO page + personal
- [ ] Member email via Addie
- [ ] Close tracking issues (search `label:3.1` or `milestone:3.1.0`)
- [ ] Decide whether to open `3.1.x` patch branch (likely yes; create from `v3.1.0` tag)
