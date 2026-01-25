---
testable: true
---

# Testable Documentation Examples

This page demonstrates the testable documentation feature with complete, working code examples that execute against the live test agent.

## JavaScript Example

### List Creative Formats

```javascript
import { testAgent } from '@adcp/client/testing';

const result = await testAgent.listCreativeFormats({});

console.log(`✓ Found ${result.data?.formats?.length || 0} creative formats`);
```

## Python Example

### List Creative Formats

```python
import asyncio
from adcp import test_agent

async def list_formats():
    result = await test_agent.simple.list_creative_formats()
    print(f"✓ Found {len(result.formats)} supported creative formats")

asyncio.run(list_formats())
```

## CLI Example

### Using uvx (Python CLI)

```bash
uvx adcp \
  https://test-agent.adcontextprotocol.org/mcp \
  list_creative_formats \
  '{}' \
  --auth 1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ
```

## How Testable Documentation Works

When `testable: true` is set in the frontmatter, ALL code blocks on this page are extracted and executed during testing.

### Running Tests

```bash
# Run all tests including snippet validation
npm run test:all
```

### Requirements for Testable Pages

Every code block must:
- Be complete and self-contained
- Import all required dependencies
- Execute without errors
- Produce output confirming success

### When to Mark Pages as Testable

Mark a page `testable: true` ONLY when:
- ALL code blocks are complete working examples
- No code fragments or incomplete snippets
- All examples use test agent credentials
- Dependencies are installed (`@adcp/client`, `adcp`)

### When NOT to Mark Pages as Testable

Do NOT mark pages testable that contain:
- Code fragments showing patterns
- Incomplete examples
- Conceptual pseudocode
- Examples requiring production credentials
- Mixed testable and non-testable content

See [Testable Snippets Guide](./testable-snippets.md) for complete documentation.
