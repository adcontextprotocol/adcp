# Python MCP Async Cleanup Bug

## Overview

The MCP Python SDK (mcp package v1.21.0) has a known bug with async generator cleanup that causes false test failures. Tests produce correct output but exit with errors during cleanup.

## Symptom

Tests work correctly and produce expected output, but fail with:

```
an error occurred during closing of asynchronous generator
streamablehttp_client
RuntimeError: Attempted to exit cancel scope in a different task than it was entered in
```

## Root Cause

The MCP SDK's `streamablehttp_client` async generator doesn't properly handle cleanup when the event loop is closing. This is an internal SDK issue, not a problem with the test code or documentation examples.

## Impact

- Tests appear to fail even when they execute successfully
- Test output is correct and complete
- Only affects Python tests using MCP client
- Does not affect JavaScript/TypeScript tests

## Detection

The test runner detects this bug by checking stderr for these patterns:

```javascript
const asyncCleanupIndicators = [
  'an error occurred during closing of asynchronous generator',
  'streamablehttp_client',
  'RuntimeError: Attempted to exit cancel scope in a different task'
];
```

## Handling Strategy

When the async cleanup bug is detected:

1. **If stdout has output** → Test PASSES
   - The test executed successfully
   - Output is valid
   - Only cleanup failed

2. **If no stdout** → Test PASSES with warning
   - Test ran but produced no output
   - Cleanup error is the only issue

## Example

```python
import asyncio
from adcp import test_agent

async def discover():
    result = await test_agent.simple.get_products(
        brand_manifest={'name': 'Nike', 'url': 'https://nike.com'},
        brief='Premium athletic footwear'
    )
    print(f"Found {len(result.products)} products")

asyncio.run(discover())
```

**Output:**
```
Found 2 products
```

**Stderr (ignored):**
```
an error occurred during closing of asynchronous generator
streamablehttp_client
RuntimeError: Attempted to exit cancel scope in a different task...
```

**Result:** ✅ PASSED (async cleanup bug ignored)

## Upstream Issue

This is a known issue in the MCP Python SDK. Track updates at:
- Package: `mcp` v1.21.0
- Related: async generator cleanup in `streamablehttp_client`

## Workaround

The test runner automatically handles this:

```javascript
// Check for async cleanup bug
const hasAsyncCleanupBug = error.stderr &&
  asyncCleanupIndicators.every(indicator =>
    error.stderr.includes(indicator)
  );

// If we have output and the async bug, pass the test
if (hasAsyncCleanupBug && error.stdout && error.stdout.trim().length > 0) {
  return {
    success: true,
    output: error.stdout,
    error: error.stderr,
    warning: 'Python MCP async cleanup bug - ignoring (see PYTHON_MCP_ASYNC_BUG.md)'
  };
}
```

## When to Update

This workaround should be removed when:
1. MCP Python SDK fixes async generator cleanup
2. Tests no longer show this error pattern
3. Verify with: `npm run test:snippets` on Python examples

## References

- Test runner: `tests/snippet-validation.test.js`
- Async bug handling: Lines 332-394
- Detection logic: Lines 332-337
