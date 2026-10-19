# SDK pin and disposable comparison evidence

Status: read-only evidence; no SDK adoption or maintenance qualification. Main's
manifest, lockfile and installed SDK remain **15.9.5**. No SDK/DSL implementation,
installer change or dependency upgrade is authorized by this packet.

Root independently corroborated registry Git heads, 15.9.6 SRI and the actual
upstream Git comparison. Catalog owner separately downloaded pristine published
payloads, compared hashes and executed the disposable public probes below.
Those payload/probe results are owner reruns, **not root or stable-reviewer reruns**.
The stable reviewer used a 15.9.4 tree plus fetched proposals and did not rerun
these suites; its structural review is not new-SDK qualification.

| Published package | Registry `gitHead` |
| --- | --- |
| 15.9.5 | `c842d2221d1b2981e5573d9e4391277d2d9ddd2f` |
| 15.9.6 | `b27b93ab510abcf21bbb1daf79f024e38e599047` |

The [actual upstream comparison](https://github.com/adcontextprotocol/adcp-client/compare/c842d2221d1b2981e5573d9e4391277d2d9ddd2f...b27b93ab510abcf21bbb1daf79f024e38e599047)
contains **two commits**: `f660ce117d020e5fd19ac44788a8f96a5e083cb9`
(creative-delivery backport #3340), then
`b27b93ab510abcf21bbb1daf79f024e38e599047` (release #3342). Neither
`src/lib/testing/storyboard/runner.ts` nor `validations.ts` changed. A claim
that this intervening release changed those files is incorrect; a 15.9.4-base
or installed-versus-pristine comparison must be labeled separately.

15.9.6 tarball integrity, checked against downloaded bytes:

```text
sha512-MlNfQzxWwO1KabJw6qUikk1NPIaGKDU8A+f/GL1MeFeYNI3TSzl2XqhXBpQlidYww3bdt9+uuTNRkywCuM02sw==
```

Pristine published CJS files are byte-identical between these releases:

| File under `dist/lib/testing/storyboard/` | SHA-256 (both releases) |
| --- | --- |
| `runner.js` | `e162c7ab84d1c2aca5a9e2755421437c7796a3124b38f798d72e33fac792a592` |
| `validations.js` | `283da7adff81bc98a0c49626bf422adb7b5c606e8f9ad833160c8497713f343c` |

Installed main's runner differs from pristine because of the **already existing**
`scripts/install-sdk-creative-build-probe.cjs` postinstall bridge and
`patches/sdk-creative-build-probe`. This work did not add, alter or remove it.
That installed-tree difference is not a 15.9.5-to-15.9.6 release delta.

## Disposable public-runner check

Owner used `npm view @adcp/sdk@<version> gitHead dist --json` and
`npm pack @adcp/sdk@<version> --ignore-scripts` only in ignored scratch directories,
verified the tarball SRI, unpacked it, and compared the pristine files. Both
versions' dependency constraints were identical. An isolated package-resolution
root selected pristine **15.9.6** with the existing resolved dependencies; no
main installation/lockfile was changed. The same
[19 public prerequisite probes](collection-prerequisite.test.cjs) ran there with
only their package-version assertion set to 15.9.6: **19/19 passed**, reproducing
the same fixed-default, capture, relation, set and standalone limitations.
Raw owner artifacts are retained in `.context/sdk-15.9.6-comparison/` in the
catalog workspace; root retained its own registry/compare response separately.

This additional experiment is **not the exact main installation** (it omits
main's preexisting postinstall bridge), not CI's version matrix, and not
SDK 14.0.0-rc.53/3.2.x qualification. The exact installed-main 15.9.5 evidence
remains valid as scoped. A new npm tag alone does not make it stale. No adoption
is necessary or authorized merely because a later tag exists.
