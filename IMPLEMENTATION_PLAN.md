# Implementation Plan: Testable Documentation & Library Discoverability

## Goal
Make AdCP documentation examples functional and testable, and improve library discoverability.

---

## Stage 1: Improve Library Discoverability
**Goal**: Make it easy for developers to find and install client libraries
**Status**: Not Started

### Tasks:
1. Create new "Client Libraries" section in intro.mdx with prominent links
2. Add NPM badge and PyPI placeholder to README.md
3. Update quickstart.mdx with clearer library installation instructions
4. Note in docs that Python client library is in development

### Success Criteria:
- [ ] Clear "Client Libraries" section visible on homepage
- [ ] NPM package link with installation instructions
- [ ] Note about Python library status
- [ ] Links to GitHub repos for both libraries

---

## Stage 2: Documentation Snippet Testing Infrastructure
**Goal**: Create framework to extract and test code snippets from documentation
**Status**: Not Started

### Tasks:
1. Create `/tests/snippet-validation.test.js` test file
2. Build snippet extractor that:
   - Parses .mdx files for code blocks
   - Identifies testable snippets (marked with metadata)
   - Extracts JavaScript/TypeScript and curl examples
3. Create test runner that executes snippets against test-agent
4. Add snippet validation to npm test command

### Success Criteria:
- [ ] Can extract code snippets from .mdx files
- [ ] Can identify which snippets should be tested
- [ ] Can execute JavaScript snippets programmatically
- [ ] Can execute curl commands and validate responses

---

## Stage 3: Make Existing Examples Testable
**Goal**: Update documentation examples to be executable and tested
**Status**: Not Started

### Tasks:
1. Audit all code examples in docs/
2. Update examples to use test-agent credentials
3. Add metadata to code blocks to indicate testability:
   ```mdx
   ```javascript test=true
   // This snippet will be tested
   ```
4. Ensure examples use realistic data
5. Add response validation expectations

### Success Criteria:
- [ ] All quickstart examples are testable
- [ ] All task reference examples are testable
- [ ] Examples use test-agent.adcontextprotocol.org
- [ ] Each example has expected output documented

---

## Stage 4: Integration with CI
**Goal**: Make snippet tests run on every commit
**Status**: Not Started

### Tasks:
1. Update package.json to include snippet tests
2. Ensure tests run in CI environment
3. Add test results to PR checks
4. Document how to add new testable examples

### Success Criteria:
- [ ] `npm test` runs snippet validation
- [ ] CI fails if snippets are broken
- [ ] Documentation for contributors on writing testable snippets
- [ ] Test coverage report includes snippet tests

---

## Stage 5: Documentation Improvements
**Goal**: Add guides for using the libraries effectively
**Status**: Not Started

### Tasks:
1. Create "Using the JavaScript Client" guide
2. Create "Python Development" guide (with MCP SDK)
3. Add error handling examples
4. Add authentication examples for both libraries

### Success Criteria:
- [ ] JavaScript client guide with complete examples
- [ ] Python guide showing MCP SDK usage
- [ ] Authentication patterns documented
- [ ] Error handling best practices
