# Client Library API Mismatch Issue

## Problem

Our documentation examples don't match the actual @adcp/client API, causing confusion and broken examples.

## Specific Issues Found

### 1. Class Name Mismatch
- **Documentation uses**: `AdcpClient` (lowercase 'dcp')
- **Library exports**: `ADCPClient` (all caps) and `AdCPClient` (capital C and P)
- **Also available**: `ADCPMultiAgentClient` (primary interface per README)

### 2. Constructor API Mismatch
- **Documentation shows**:
  ```javascript
  const client = new AdcpClient({
    agentUrl: 'https://...',
    protocol: 'mcp',
    bearerToken: 'token'
  });
  ```

- **Actual API**:
  ```javascript
  const client = new ADCPMultiAgentClient([{
    id: 'agent-id',
    agent_uri: 'https://...',
    protocol: 'mcp',
    auth: {
      type: 'bearer',
      token: 'token'
    }
  }]);

  const agent = client.agent('agent-id');
  ```

### 3. Response Structure Mismatch
- **Documentation implies**: `result.products`
- **Actual structure**: `{ success, status, error, metadata, debug_logs, data? }`
- **Note**: `data` field only present on success, contains the actual response payload

### 4. Test Agent Requirements
The test agent at `https://test-agent.adcontextprotocol.org/mcp` is rejecting requests with:
```
"brand_manifest must provide brand information"
```

Even when providing a brand_manifest object, suggesting either:
- The test agent has stricter validation than documented
- The test agent configuration is incorrect
- There's a mismatch between the protocol spec and implementation

## Impact

1. **Documentation examples don't work** - Users copy/paste examples that fail
2. **Testing infrastructure blocked** - Can't mark examples as testable because they fail
3. **User confusion** - Multiple class names and APIs create confusion about which to use
4. **Protocol mismatch** - Test agent behavior doesn't match documented requirements

## Recommendations

### Short-term (This PR)
1. ✅ Fix regex in snippet validation to preserve import statements
2. ✅ Add links to NPM and PyPI packages
3. ✅ Create testable snippet infrastructure
4. ⚠️  Don't mark JavaScript client examples as testable until API is aligned
5. ✓  Use curl examples for testable snippets (protocol-level, always accurate)

### Medium-term (Follow-up PR)
1. **Audit all documentation** for AdcpClient vs ADCPClient usage
2. **Sync with @adcp/client maintainers** on the canonical API
3. **Update constructor examples** to match actual multi-agent client API
4. **Test against actual implementation** rather than assumed API
5. **Fix or document test agent requirements** for brand_manifest

### Long-term (Architecture)
1. **Single source of truth** - Generate docs from TypeScript types?
2. **CI integration** - Run actual client library tests against documentation
3. **Versioning** - Link docs version to client library version
4. **Protocol compliance testing** - Ensure test agent matches protocol spec

## Files Affected

- `docs/quickstart.mdx` - Uses incorrect `AdcpClient` class name
- `docs/intro.mdx` - May have similar issues
- All task reference docs - Likely have constructor API mismatches
- `snippets/client-setup.mdx` - Uses incorrect API
- `snippets/example-get-products.mdx` - Uses incorrect API

## Testing Results

- ✅ Regex fix works - import statements now preserved
- ✅ Test infrastructure works - can extract and run code
- ❌ JavaScript examples fail - API mismatch
- ❓ Python client - Not tested (requires Python 3.10+)
- ✓  curl examples - Would work (direct protocol calls)

## Next Steps

1. Create GitHub issue to track API alignment work
2. Add curl-based testable examples as temporary solution
3. Work with client library maintainers to align APIs
4. Update all documentation once alignment is complete
5. Enable JavaScript example testing after fixes
