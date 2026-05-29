---
---

server(compliance): allow the hosted badge target's prerelease cache to run
when a seller advertises the stable AdCP line in `adcp.supported_versions`.
During the 3.1 readiness window, the public target remains `3.1` while the
checked-in compliance bundle can still be `3.1.0-beta.N`; the hosted runner now
treats `supported_versions: ["3.1"]` as compatible with that cache gate so
sellers do not have to redeploy for every beta cache bump.
