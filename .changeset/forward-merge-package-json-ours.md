---
---

`forward-merge-3.0.yml` auto-resolution rule for `package.json` and `package-lock.json` changes from `--theirs` to `--ours` (preserve main's state).

The original `--theirs` rule worked when main and 3.0.x diverged only on the version field. But main may have structural changes that 3.0.x doesn't — concrete case: main's `@adcp/client@5.21.1` was renamed to `@adcp/sdk@5.25.1` while 3.0.x kept the old name. Wholesale `--theirs` stripped main's package rename, leaving `package.json` and `package-lock.json` out of sync, which broke `npm ci` on the auto-PR.

`--ours` is safer because:
- Main's pre-mode tracking is independent of 3.0.x's version field. The next pre-mode cut produces `3.1.0-beta.X` from accumulated changesets regardless of starting version.
- The release artifacts (`dist/{schemas,compliance,protocol}/X.Y.Z/`) DO flow forward via the `dist/*` allowlist entry, so consumers fetching pinned versions still get them.
- Main's structural changes (package renames, new deps, new test scripts) are preserved.

Trade-off: main's `package.json` version doesn't reflect 3.0.x's latest release. Acceptable — the version field on main isn't authoritative while pre-mode is active.

Companion playbook update so the documented rule matches the new behavior.
