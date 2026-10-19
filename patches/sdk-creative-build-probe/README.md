Temporary SDK bridge for adcp#8240. Upstream source and executable tests:
https://github.com/adcontextprotocol/adcp-client/pull/3332

Qualified upstream source: `9f932f174e8125e00ec55d64db2a292cba2be7f9`.

The manifest contains bounded insertions into SDK **15.9.5** loader, runner and
matching declarations, plus the shared resolver compiled from upstream source.
It does not replace the whole newer SDK runner. Both public CJS and ESM entry
points receive the same preparation, including standalone steps. Existing global
accounting and required-phase/vacuous-pass guards remain unchanged.

`node scripts/install-sdk-creative-build-probe.cjs` validates package identity,
all target preimages/postimages, unique insertion anchors and deterministic helper
bytes before writing. A repeated complete installation is a no-op; drift or a
mixed state fails loudly. Normal installs run this as postinstall. Docker's
`--ignore-scripts` stages explicitly invoke only this trusted installer, as does
the SDK conformance workflow. Tests reconstruct stock bytes and exercise both
public module entry points before and after explicit installation.

The automatic source recipe relies on existing format completeness semantics;
operator recipes assert account-specific valid input for every route matched by
the existing fixture DSL. Capability catalogs follow the SDK-authorized served release; build selectors,
source manifests and dispatch retain the run pin. Missing source/preconditions yield visible coverage
gaps, not passing security credit. See the authored runner test-kit contract.

Qualification/removal: upgrade to a published SDK containing the upstream fix,
remove this directory, installer, lifecycle/Docker/workflow calls and owned shim
ledger entry, then run the complete authored fixture and bridge/standalone
regressions with the public replacement. This task publishes no release.

To refresh while upstream review is in progress, rebuild that SDK commit, copy
only creative-build-probe.{js,mjs,d.ts,d.mts}, and regenerate the bounded insertion
blocks and SHA-256 pre/postimage hashes against a pristine npm SDK15.9.5 install.
Review the resulting manifest and rerun integrity/public-entry regressions.
