# Writing Testable Documentation Snippets

This guide explains how to write code examples in AdCP documentation that are automatically tested for correctness.

## Why Test Documentation Snippets?

Automated testing of documentation examples ensures:
- Examples stay up-to-date with the latest API
- Code snippets actually work as shown
- Breaking changes are caught immediately
- Users can trust the documentation

**Important**: The test infrastructure validates code blocks **directly in the documentation files** (`.md` and `.mdx`). When you mark a snippet with `test=true`, that exact code from the documentation is extracted and executed.

## Marking Snippets for Testing

To mark a code block for testing, add `test=true` or `testable` after the language identifier:

### JavaScript/TypeScript Examples

````markdown
```javascript test=true
import { AdcpClient } from '@adcp/client';

const client = new AdcpClient({
  agentUrl: 'https://test-agent.adcontextprotocol.org/mcp',
  protocol: 'mcp',
  bearerToken: '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ'
});

const products = await client.getProducts({
  promoted_offering: 'Nike Air Max 2024'
});

console.log(`Found ${products.products.length} products`);
```
````

### Bash/curl Examples

````markdown
```bash testable
curl -X POST https://test-agent.adcontextprotocol.org/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ" \
  -d '{
    "jsonrpc": "2.0",
    "id": "req-123",
    "method": "tools/call",
    "params": {
      "name": "get_products",
      "arguments": {
        "promoted_offering": "Nike Air Max 2024"
      }
    }
  }'
```
````

### Python Examples

````markdown
```python test=true
from mcp import Client

client = Client("https://test-agent.adcontextprotocol.org/mcp")
client.authenticate("1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ")

products = client.call_tool("get_products", {
    "promoted_offering": "Nike Air Max 2024"
})

print(f"Found {len(products['products'])} products")
```
````

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

## When NOT to Mark Snippets for Testing

Some code blocks shouldn't be tested:

### 1. Pseudo-code or Conceptual Examples

```javascript
// Don't test this - it's conceptual
const result = await magicFunction(); // ✗ Not a real function
```

### 2. Incomplete Code Fragments

```javascript
// Don't test - incomplete fragment
budget: 10000,
start_date: '2025-11-01'
```

### 3. Configuration/JSON Schema Examples

```json
{
  "product_id": "example",
  "name": "Example Product"
}
```

### 4. Response Examples

```json
{
  "products": [
    {"product_id": "prod_123", "name": "Premium Display"}
  ]
}
```

### 5. Language-Specific Features Not Available in Node.js

```typescript
// Don't test - browser-only API
const file = await window.showOpenFilePicker();
```

## Running Snippet Tests

### Locally

Test all documentation snippets:

```bash
npm run test:snippets
```

This will:
1. Scan all `.md` and `.mdx` files in `docs/`
2. Extract code blocks marked with `test=true` or `testable`
3. Execute each snippet and report results
4. Exit with error if any tests fail

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

1. ✅ **DO** mark working examples as testable
2. ✅ **DO** use test agent credentials in examples
3. ✅ **DO** test snippets locally before committing
4. ✅ **DO** keep examples self-contained
5. ❌ **DON'T** mark incomplete fragments for testing
6. ❌ **DON'T** mark pseudo-code for testing
7. ❌ **DON'T** use production credentials in examples

## Questions?

- Check existing testable examples in `docs/quickstart.mdx`
- Review the test suite: `tests/snippet-validation.test.js`
- Ask in [Slack Community](https://join.slack.com/t/agenticads/shared_invite/zt-3c5sxvdjk-x0rVmLB3OFHVUp~WutVWZg)
