---
"adcontextprotocol": minor
---

Add testable documentation infrastructure and improve library discoverability

**Library Discoverability:**
- Added prominent "Client Libraries" section to intro.mdx with NPM badge and installation links
- Updated README.md with NPM package badge and client library installation instructions
- Documented Python client development status (in development, use MCP SDK directly)
- Added links to NPM package, PyPI (future), and GitHub repositories

**Documentation Snippet Testing:**
- Created comprehensive snippet validation test suite (`tests/snippet-validation.test.js`)
- Extracts code blocks from all documentation files (.md and .mdx)
- Tests JavaScript, TypeScript, Python, and Bash (curl) examples
- Snippets marked with `test=true` or `testable` are automatically validated
- Integration with test suite via `npm run test:snippets` and `npm run test:all`
- Added contributor guide for writing testable documentation snippets

**What this enables:**
- Documentation examples stay synchronized with protocol changes
- Broken examples are caught in CI before merging
- Contributors can confidently update examples knowing they'll be tested
- Users can trust that documentation code actually works

**For contributors:**
See `docs/contributing/testable-snippets.md` for how to write testable documentation examples.
