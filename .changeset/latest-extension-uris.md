---
"adcontextprotocol": patch
---

`dist/schemas/latest/extensions/` publishes its schemas under `/schemas/latest/`, like the rest of `latest/`. The build filtered extensions by the package release and also stamped that release into the `latest/` copies, so `extension-meta.json` referenced `/schemas/3.3.0-rc.2/core/adcp-minor-version.json`, a file that no build had published. Versioned builds still publish under their own version, and the build still filters extensions by the release.
