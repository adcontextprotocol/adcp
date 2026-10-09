---
title: Testable examples demo
description: "AdCP testable documentation demo: validated JSON schemas and executable JavaScript code blocks that run against a live test agent."
"og:title": "AdCP — Testable examples demo"
testable: true
---

# Testable Documentation Examples

This page demonstrates the testable documentation feature with complete, working code examples that execute against the live test agent.

## JavaScript Example

### Discover Creative Capabilities

```javascript
import { testAgent } from '@adcp/sdk/testing';

const result = await testAgent.getAdcpCapabilities({});

console.log(`✓ Found ${result.data?.creative?.supported_formats?.length || 0} creative capabilities`);
```

## Python Example

### Discover Creative Capabilities

```python
import asyncio
from adcp.testing import test_agent

async def list_formats():
    result = await test_agent.simple.get_adcp_capabilities()
    print(f"✓ Found {len(result.creative.supported_formats)} creative capabilities")

asyncio.run(list_formats())
```

## CLI Example

### Using uvx (Python CLI)

```bash requires-env=ADCP_AUTH_TOKEN
uvx adcp \
  https://test-agent.adcontextprotocol.org/creative/mcp \
  get_adcp_capabilities \
  '{}' \
  --auth $ADCP_AUTH_TOKEN
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
- Dependencies are installed (`@adcp/sdk`, `adcp`)

### When NOT to Mark Pages as Testable

Do NOT mark pages testable that contain:
- Code fragments showing patterns
- Incomplete examples
- Conceptual pseudocode
- Examples requiring production credentials
- Mixed testable and non-testable content

See [Testable Snippets Guide](./testable-snippets.md) for complete documentation.
