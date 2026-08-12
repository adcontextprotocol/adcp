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

## Schema conventions
Before adding or modifying schemas, read the [Specification Guidelines](https://github.com/adcontextprotocol/adcp/blob/main/docs/spec-guidelines.md). In particular, normative (non-`ext`) schema fields must not reference specific platforms or vendors by name — platform-specific fields belong in the `ext.{vendor}` namespace. Reviewers will flag violations.

## Examples and sample data
Docs, storyboards, and test vectors use **fictional brands and entities only** — Acme Outdoor, Nova Motors, Pinnacle Agency, StreamHaus, and the other names in `static/compliance/source/test-kits/`. Real brand, agency, publisher, or vendor names do not appear in normative examples. See the editorial rule in [`CLAUDE.md`](https://github.com/adcontextprotocol/adcp/blob/main/CLAUDE.md) and the universal fictional-entity registry at `static/compliance/source/universal/fictional-entities.yaml`. Reviewers will flag real-brand usage in examples the same way they flag vendor leakage in schemas.

## Review and merge policy

Pull request authors may merge their own changes after all required checks pass
and the current head commit has the approvals required by branch protection and
CODEOWNERS. An approving Secretariat review satisfies the review requirement for
an editorial change when no gated path or other rule requires a specific human
reviewer.

Self-merge is not permitted for breaking changes, governance decisions,
constitutional changes, or changes to gated paths that require designated human
approval. It is also not permitted while a review requests changes, explicitly
asks for human approval, or is stale because the head commit changed after the
approval. The Secretariat prepares and reviews these changes but does not merge
them; normative and breaking decisions follow the authority rules in
[`.agents/wg/constitution.md`](.agents/wg/constitution.md).

## Issues
[adcontextprotocol.org](http://adcontextprotocol.org/) contains documentation that may help answer questions you have about using AdCP.
If you can't find the answer there, try searching for a similar issue on the [issues page](https://github.com/adcontextprotocol/adcp/issues).
If you don't find an answer there, [open a new issue](https://github.com/adcontextprotocol/adcp/issues/new).

## License
Please see [LICENSE](https://github.com/adcontextprotocol/adcp/blob/main/LICENSE) for the license associated with the AdCP project.
All source code, documentation, and supporting materials making up this repository are subject to the license.
