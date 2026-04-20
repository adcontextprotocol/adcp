# Contributing to AdCP
Contributions are always welcome. To contribute, [fork](https://help.github.com/articles/fork-a-repo/) adcp,
commit your changes, and [open a pull request](https://help.github.com/articles/using-pull-requests/) against the
main branch.

## Intellectual Property Rights
Before contributing to the AdCP project, you must agree to our [Intellectual Property Rights Policy](https://github.com/adcontextprotocol/adcp/blob/main/IPR_POLICY.md).

When you open a pull request, an automated check will ask you to confirm your agreement by commenting `I have read the IPR Policy` on your PR. This is a one-time requirement per contributor.

## Contributing
Before contributing please see:
- [README.md](https://github.com/adcontextprotocol/adcp/blob/main/README.md)
- [RELEASING.md](https://github.com/adcontextprotocol/adcp/blob/main/RELEASING.md)
- [SECURITY.md](https://github.com/adcontextprotocol/adcp/blob/main/SECURITY.md)

## Writing compliance storyboards
Storyboards under `static/compliance/source/` drive the compliance test runner. Authoring conventions — tenant scoping, `sample_request` identity shapes, and the `scoping: global` opt-out for cross-tenant probes — are documented in [docs/contributing/storyboard-authoring.md](docs/contributing/storyboard-authoring.md). A scoping lint enforces the invariants on every `npm run build:compliance`.

## Issues
[adcontextprotocol.org](http://adcontextprotocol.org/) contains documentation that may help answer questions you have about using AdCP.
If you can't find the answer there, try searching for a similar issue on the [issues page](https://github.com/adcontextprotocol/adcp/issues).
If you don't find an answer there, [open a new issue](https://github.com/adcontextprotocol/adcp/issues/new).

## License
Please see [LICENSE](https://github.com/adcontextprotocol/adcp/blob/main/LICENSE) for the license associated with the AdCP project.
All source code, documentation, and supporting materials making up this repository are subject to the license.
