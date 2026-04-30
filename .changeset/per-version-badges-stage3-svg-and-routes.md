---
---

backend(verification): badge SVG version segment + version-pinned URLs. Stage 3 of #3524.

Badge labels now embed the AdCP release between the role and the qualifier:

| Before | After |
|---|---|
| `Media Buy Agent (Spec)` | `Media Buy Agent 3.0 (Spec)` |
| `Media Buy Agent (Spec + Live)` | `Media Buy Agent 3.1 (Spec + Live)` |

The legacy URL `/badge/{role}.svg` keeps working — it serves the highest active version's badge and the embedded image auto-upgrades when an agent earns a newer version. Embedded badges in the wild keep their stable URL.

New version-pinned URL: **`/api/registry/agents/{url}/badge/{role}/{version}.svg`** lets buyers freeze on a specific release. Returns the (Spec)/(Live) qualifier earned at exactly that version, or "Not Verified" if the agent never earned a badge there. Path-segment form (not query string) for clean shields.io-style cache keys.

Parallel embed endpoint: **`/api/registry/agents/{url}/badge/{role}/{version}/embed`** returns HTML/Markdown snippets that point at the version-pinned SVG, with alt text including the version (`AAO Verified Media Buy Agent 3.0`).

Validation: `^[1-9][0-9]{0,3}\.[0-9]{1,3}$` on the route, identical shape to the JWT signer and DB CHECK. Bounded length defends against pathological URLs filling logs. Invalid version → 400 with a clear error message.

Defense-in-depth in `renderBadgeSvg`: a malformed `adcpVersion` drops from the rendered label rather than failing the image. Unlike the JWT signer (which fails closed because a partial token is a downgrade vector), a missing badge image is worse for the buyer than a less-specific one — so the SVG renders verified-without-version when the value can't be trusted.

ETag: `${role}-${version}-${modes}` so the cache invalidates on version transitions and qualifier changes.

8 new tests cover the version segment: embed-when-set, omit-when-absent, drop-on-malformed (SQL-injection-shaped), reject-leading-zero, reject-full-semver, double-digit minor preservation, and "Not Verified" labels never carry a version.

What this PR does NOT change:

- Verification panel still renders one row per role. **Stage 4** splits into one row per (role, version).
- brand.json enrichment shape unchanged. **Stage 5** adds the `badges[]` array with version detail.
- The legacy non-versioned embed URL keeps working unchanged.
