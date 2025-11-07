# AdCP Examples

This directory contains standalone example scripts that demonstrate AdCP functionality.

## Purpose

These examples serve as:
- **Reference implementations** for common use cases
- **Standalone scripts** you can run directly
- **Integration testing** examples for the test agent

## Important Note

**These examples are NOT directly connected to the documentation testing system.**

The documentation snippet testing system (see `tests/snippet-validation.test.js`) tests code blocks **directly from the documentation files** (`.md` and `.mdx` files in the `docs/` directory).

When you mark a code block in documentation with `test=true`:
```markdown
\`\`\`javascript test=true
// This exact code is extracted and tested
import { AdcpClient } from '@adcp/client';
// ...
\`\`\`
```

The testing system:
1. Extracts the code block from the markdown
2. Writes it to a temporary file
3. Executes it
4. Reports pass/fail

## Running Examples

Each example script can be run independently:

```bash
# Test agent connectivity
node examples/test-snippet-example.js

# Full quickstart validation
node examples/quickstart-test.js
```

## Adding New Examples

When adding new examples:
1. Make them self-contained and executable
2. Include clear comments explaining what they demonstrate
3. Use the test agent credentials (see examples for reference)
4. Add a description here in this README

## Examples in This Directory

### test-snippet-example.js
Basic connectivity test that:
- Fetches the agent card from the test agent
- Validates the agent is reachable
- Demonstrates minimal setup required

### quickstart-test.js
Comprehensive quickstart validation that:
- Tests agent card retrieval
- Validates connectivity
- Shows next steps for users
