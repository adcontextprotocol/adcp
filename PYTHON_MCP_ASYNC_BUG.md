# Python MCP Client Async Cleanup Bug

## Summary

The Python MCP client (`@modelcontextprotocol/sdk`) has an async generator cleanup issue that causes scripts to exit with error code 1 even when the actual API call succeeds and produces correct output.

## Environment

- **Python**: 3.12.8
- **Package**: `mcp` (via `adcp` Python client)
- **MCP SDK**: Uses `streamablehttp_client` async generator
- **Platform**: macOS (Darwin 25.1.0)

## Bug Description

When using the AdCP Python client with test helpers like `test_agent.simple.get_products()`, the script:
1. ✅ Successfully makes the API call
2. ✅ Successfully processes the response
3. ✅ Successfully prints output
4. ❌ Exits with error code 1 due to async generator cleanup failure

## Error Output

```
an error occurred during closing of asynchronous generator <async_generator object streamablehttp_client at 0x...>
asyncgen: <async_generator object streamablehttp_client at 0x...>
  + Exception Group Traceback (most recent call last):
  |   File ".../anyio/_backends/_asyncio.py", line 781, in __aexit__
  |     raise BaseExceptionGroup(
  | BaseExceptionGroup: unhandled errors in a TaskGroup (1 sub-exception)
  +-+---------------- 1 ----------------
    | Traceback (most recent call last):
    |   File ".../mcp/client/streamable_http.py", line 502, in streamablehttp_client
    |     yield (
    | GeneratorExit
    +------------------------------------

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File ".../mcp/client/streamable_http.py", line 478, in streamablehttp_client
    async with anyio.create_task_group() as tg:
               ^^^^^^^^^^^^^^^^^^^^^^^^^
  File ".../anyio/_backends/_asyncio.py", line 787, in __aexit__
    if self.cancel_scope.__exit__(type(exc), exc, exc.__traceback__):
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File ".../anyio/_backends/_asyncio.py", line 459, in __exit__
    raise RuntimeError(
RuntimeError: Attempted to exit cancel scope in a different task than it was entered in
```

## Minimal Reproduction

```python
import asyncio
from adcp import test_agent

async def test():
    result = await test_agent.simple.get_products(
        brand_manifest={'name': 'Nike', 'url': 'https://nike.com'},
        brief='Athletic footwear'
    )
    print(f"Found {len(result.products)} products")

asyncio.run(test())
```

**Expected**: Exit code 0 with output
**Actual**: Exit code 1 with output + async cleanup error

## Impact

- **Scripts appear to fail** even though they succeed functionally
- **Test runners** (like Jest, pytest) mark passing tests as failed
- **CI/CD pipelines** fail on exit code checks
- **Makes Python examples untestable** in automated documentation tests

## Workaround Attempted

Adding explicit cleanup with `await test_agent.close()` does not resolve the issue - the error still occurs during the final async generator cleanup.

## Root Cause

The issue appears to be in how the MCP client's `streamablehttp_client` async generator handles cleanup when the script exits. The generator is being closed in a different async task context than where it was created, causing the `anyio` cancel scope violation.

## Files Affected

In the AdCP testable documentation project, this affects:
- All Python examples using `test_agent.simple.*` methods
- Approximately 9 test cases in `tests/snippet-validation.test.js`

## Expected Fix

The MCP client should properly clean up async generators without raising exceptions, or provide a documented cleanup method that prevents the error.

## Additional Context

- JavaScript/TypeScript MCP clients do not have this issue
- The actual API functionality works correctly - only cleanup fails
- This appears to be specific to the Python MCP SDK's HTTP streaming implementation
- The error happens consistently across all async test_agent operations
