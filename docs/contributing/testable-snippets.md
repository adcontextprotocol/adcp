# Writing Testable Documentation Snippets

This guide explains how to write code examples in AdCP documentation that are automatically tested for correctness.

## Why Test Documentation Snippets?

Automated testing of documentation examples ensures:
- Examples stay up-to-date with the latest API
- Code snippets actually work as shown
- Breaking changes are caught immediately
- Users can trust the documentation

**Important**: The test infrastructure validates code blocks **directly in the documentation files** (`.md` and `.mdx`). When you mark a page with `testable: true` in the frontmatter, ALL code blocks on that page are extracted and executed.

## Marking Pages for Testing

To mark an entire page as testable, add `testable: true` to the frontmatter:

```markdown
---
title: get_products
testable: true
---

# get_products

...all code examples here will be tested...
```

**Key principle**: Pages should be EITHER fully testable OR not testable at all. We don't support partially testable pages (mixing testable and non-testable code blocks on the same page).

### Example Code Blocks

Once a page is marked `testable: true`, all code blocks are executed:

````markdown
```javascript
import { testAgent } from '@adcp/client/testing';

const products = await testAgent.getProducts({
  brief: 'Premium athletic footwear with innovative cushioning',
  brand: {
    domain: 'nike.com'
  }
});

console.log(`Found ${products.products.length} products`);
```
````

### Using Test Helpers

For simpler examples, use the built-in test helpers from client libraries:

**JavaScript:**
```javascript
import { testAgent, testAgentNoAuth } from '@adcp/client/testing';

// Authenticated access
const fullCatalog = await testAgent.getProducts({
  brief: 'Premium CTV inventory'
});

// Unauthenticated access
const publicCatalog = await testAgentNoAuth.getProducts({
  brief: 'Premium CTV inventory'
});
```

**Python:**
```python
import asyncio
from adcp.testing import test_agent, test_agent_no_auth

async def example():
    # Authenticated access
    full_catalog = await test_agent.simple.get_products(
        brief='Premium CTV inventory'
    )

    # Unauthenticated access
    public_catalog = await test_agent_no_auth.simple.get_products(
        brief='Premium CTV inventory'
    )

asyncio.run(example())
```

## Best Practices

### 1. Use Test Agent Credentials

Always use the public test agent for examples:

- **Test Agent URL**: `https://test-agent.adcontextprotocol.org`
- **MCP Token**: `1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ`
- **A2A Token**: `L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8`

### 2. Make Examples Self-Contained

Each testable snippet should:
- Import all required dependencies
- Initialize connections
- Execute a complete operation
- Produce visible output (console.log, etc.)

**Good Example:**
```javascript
// Example of a complete, testable snippet
import { AdcpClient } from '@adcp/client';

const client = new AdcpClient({
  agentUrl: 'https://test-agent.adcontextprotocol.org/mcp',
  protocol: 'mcp',
  bearerToken: '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ'
});

const products = await client.getProducts({
  promoted_offering: 'Nike Air Max 2024'
});

console.log('Success:', products.products.length > 0);
```

**Bad Example (incomplete):**
```javascript
// Don't mark this for testing - it's incomplete
const products = await client.getProducts({
  promoted_offering: 'Nike Air Max 2024'
});
```

### 3. Use Dry Run Mode

When demonstrating operations that modify state (create, update, delete), use dry run mode:

```javascript
// Example showing dry run mode usage
const mediaBuy = await client.createMediaBuy({
  product_id: 'prod_123',
  budget: 10000,
  start_date: '2025-11-01',
  end_date: '2025-11-30'
}, {
  dryRun: true  // No actual campaign created
});

console.log('Dry run successful');
```

### 4. Handle Async Operations

JavaScript/TypeScript examples should use `await` or `.then()`:

```javascript
// Using await (recommended)
const products = await client.getProducts({...});

// Or using .then()
client.getProducts({...}).then(products => {
  console.log('Products:', products.products.length);
});
```

### 5. Keep Examples Focused

Each testable snippet should demonstrate ONE concept:

```javascript
// Good: Demonstrates authentication
import { AdcpClient } from '@adcp/client';

const client = new AdcpClient({
  agentUrl: 'https://test-agent.adcontextprotocol.org/mcp',
  protocol: 'mcp',
  bearerToken: '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ'
});

console.log('Authenticated:', client.isAuthenticated);
```

## When NOT to Mark Pages as Testable

Some documentation pages should NOT have `testable: true`:

### 1. Pages with Pseudo-code or Conceptual Examples

If your page includes conceptual examples that aren't meant to execute:

```javascript
// Conceptual workflow - not actual code
const result = await magicFunction(); // ✗ Not a real function
```

### 2. Pages with Incomplete Code Fragments

Pages showing partial code snippets for illustration:

```javascript
// Incomplete fragment showing field structure
budget: 10000,
start_date: '2025-11-01'
```

### 3. Pages with Configuration/Schema Examples

Documentation showing JSON schemas or configuration structures:

```json
{
  "product_id": "example",
  "name": "Example Product"
}
```

### 4. Pages with Response Examples

Pages showing example API responses (not requests):

```json
{
  "products": [
    {"product_id": "prod_123", "name": "Premium Display"}
  ]
}
```

### 5. Pages with Mixed Testable and Non-Testable Code

If your page has SOME runnable code but SOME conceptual code, split into separate pages:
- One page marked `testable: true` with complete, runnable examples
- Another page without the flag for conceptual/partial examples

**Remember**: Every code block on a testable page will be executed. If any block can't run, don't mark the page as testable.

## Running Snippet Tests

### Locally

Test all documentation snippets:

```bash
npm test
```

Or specifically run the snippet tests:

```bash
node tests/snippet-validation.test.js
```

This will:
1. Scan all `.md` and `.mdx` files in `docs/`
2. Find pages with `testable: true` in frontmatter
3. Extract ALL code blocks from those pages
4. Execute each snippet and report results
5. Exit with error if any tests fail

### In CI/CD

The full test suite (including snippet tests) can be run with:

```bash
npm run test:all
```

This includes:
- Schema validation
- Example validation
- Snippet validation
- TypeScript type checking

## Supported Languages

Currently supported languages for testing:

- **JavaScript** (`.js`, `javascript`, `js`)
- **TypeScript** (`.ts`, `typescript`, `ts`) - compiled to JS
- **Bash** (`.sh`, `bash`, `shell`) - only `curl` commands
- **Python** (`.py`, `python`) - requires Python 3 installed

### Limitations

**Package Dependencies**: Snippets that import external packages (like `@adcp/client` or `adcp`) will only work if:
1. The package is installed in the repository's `node_modules`
2. Or the package is listed in `devDependencies`

For examples requiring the client library, you have options:
- **Option 1**: Add the library to `devDependencies` so tests can import it
- **Option 2**: Don't mark those snippets as testable; document them as conceptual examples instead
- **Option 3**: Use curl/HTTP examples for testable documentation (no package dependencies)

## Debugging Failed Tests

When a snippet test fails:

1. **Check the error message** - The test output shows which file and line number failed
2. **Run the snippet manually** - Copy the code and run it locally
3. **Verify test agent is accessible** - Check https://test-agent.adcontextprotocol.org
4. **Check dependencies** - Ensure all imports are available
5. **Review the snippet** - Make sure it's self-contained

Example error output:

```
Testing: quickstart.mdx:272 (javascript block #6)
  ✗ FAILED
    Error: Cannot find module '@adcp/client'
```

This indicates the `@adcp/client` package needs to be installed.

## Contributing Guidelines

When adding new documentation:

1. ✅ **DO** mark entire pages as `testable: true` if ALL code blocks are runnable
2. ✅ **DO** use test helpers from client libraries for simpler examples
3. ✅ **DO** test snippets locally before committing (`npm test`)
4. ✅ **DO** keep examples self-contained and complete
5. ✅ **DO** use test agent credentials in examples
6. ❌ **DON'T** mark pages with ANY incomplete fragments as testable
7. ❌ **DON'T** mark pages with pseudo-code as testable
8. ❌ **DON'T** mix testable and non-testable code on the same page
9. ❌ **DON'T** use production credentials in examples

## Questions?

- Check existing testable examples in `docs/quickstart.mdx`
- Review the test suite: `tests/snippet-validation.test.js`
- Ask in [Slack Community](https://join.slack.com/t/agenticads/shared_invite/zt-3c5sxvdjk-x0rVmLB3OFHVUp~WutVWZg)
