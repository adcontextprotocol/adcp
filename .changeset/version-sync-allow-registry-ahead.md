---
---

Fix the pre-push version-sync hook so contributors can push during forward-merge windows.

The hook required `package.json`, `published_version`, and `adcp_version` to all be exactly equal. The forward-merge release process (#3807) deliberately keeps `package.json --ours` on main, so during the window between cutting a version and bumping the dev package, registry is ahead of `package.json` by design — and pre-push failed for every contributor (May 2026: package.json=3.0.3, registry=3.0.4).

Now: registry must be at or ahead of `package.json`. Still fails for the genuine bug-modes — registry behind `package.json`, either field missing, or the two registry fields disagreeing. Pre-release tags (`-beta.0`) fall back to strict equality so beta windows still require lockstep.

Also adds the missing `published_version: "3.0.4"` to `static/schemas/source/index.json` to match the `adcp_version` already there. Both registry fields now agree and are ahead of the dev package.
