# Documentation Snippet Testing

This directory contains the test runner for validating code snippets in documentation files.

## Quick Start

```bash
# Test only changed/new files (uses cache)
npm test

# Test a specific file
npm test -- --file docs/quickstart.mdx

# Test all files (ignore cache)
npm test -- --all

# Clear cache and test everything
npm test -- --clear-cache
```

## How It Works

### Caching System

The test runner maintains a `.tested-files.json` cache to avoid re-testing files that:
1. Haven't changed since last test (based on MD5 hash)
2. Passed all tests last time

**Benefits:**
- Much faster iteration when fixing individual files
- Only test what you're working on
- Automatically re-tests files when they change

**Cache location:** `tests/.tested-files.json` (gitignored)

### Marking Code Snippets as Testable

By default, code blocks are NOT tested. To mark a code block for testing:

**Page-level (test all blocks in file):**
```markdown
---
title: My Page
testable: true
---
```

**Block-level (test specific block):**
````markdown
```javascript test=true
// This code will be tested
```

```javascript test=false
// This code will NOT be tested
```
````

**Supported languages:**
- `javascript` / `typescript` - Runs with Node.js
- `python` - Runs with Python 3.11+
- `bash` - Supports `curl`, `npx`, `uvx` commands

## Common Workflows

### Workflow 1: Fixing a Specific File

```bash
# 1. Run tests to see what's failing
npm test

# 2. Fix one specific file
npm test -- --file docs/media-buy/task-reference/sync_creatives.mdx

# 3. Keep fixing until that file passes
# The file will be cached once it passes

# 4. Move to next file
npm test -- --file docs/media-buy/task-reference/create_media_buy.mdx
```

### Workflow 2: Incremental Progress

```bash
# 1. First run - test everything
npm test -- --clear-cache

# Output:
# Files tested: 50
# Passed: 10 files
# Failed: 40 files

# 2. Fix some files, run again
npm test

# Output:
# Files cached (skipped): 10   <- Already passed
# Files tested: 40              <- Only test changed files
# Passed: 5 files               <- 5 more fixed!
# Failed: 35 files

# 3. Continue until done
```

### Workflow 3: Final Validation

```bash
# Before PR: test everything from scratch
npm test -- --all

# Ensures nothing broke due to dependencies
```

## Test Output

The runner shows file-by-file progress:

```
Testing file: media-buy/task-reference/sync_creatives.mdx
  Found 8 testable snippets
  Testing: sync_creatives.mdx:22 (javascript block #0)
    ✓ PASSED
  Testing: sync_creatives.mdx:47 (python block #1)
    ✓ PASSED
  ...
  ✅ File passed (8/8 snippets)

Testing file: media-buy/task-reference/create_media_buy.mdx
  Found 6 testable snippets
  Testing: create_media_buy.mdx:18 (javascript block #0)
    ✗ FAILED
    Error: ReferenceError: agent is not defined
  ...
  ❌ File failed (4/6 passed, 2 failed)
```

## Incomplete Code Snippets

Some documentation shows **partial code** for illustration (not complete runnable examples). These should be marked as non-testable:

```markdown
```javascript test=false
// This is just showing the concept, not a complete example
const result = await agent.someMethod();
```
```

**When to mark `test=false`:**
- Partial code showing a concept
- Code with placeholder variables (`YOUR_API_KEY`, etc.)
- Code requiring external setup not in the snippet
- Examples of error conditions or edge cases

**When to make code complete instead:**
- If it's meant to be a working example users can copy-paste
- If the code demonstrates actual API usage
- If marking everything as `test=false` (should reconsider the examples)

## Cache Management

### When cache is used
- Default `npm test` - only tests changed/new files
- Failed files are automatically removed from cache

### When cache is bypassed
- `--file` flag - always tests the specified file
- `--all` flag - tests everything but doesn't clear cache
- `--clear-cache` flag - deletes cache then tests everything

### Manual cache management
```bash
# View cache
cat tests/.tested-files.json

# Delete cache
rm tests/.tested-files.json

# Or use the flag
npm test -- --clear-cache
```

## Troubleshooting

### "All files already tested and passing!"

This means all files are in the cache and haven't changed. Options:
- Modify a file to trigger re-testing
- Use `--all` to re-test everything
- Use `--clear-cache` to reset

### Tests failing on unchanged files

If a file that was passing starts failing without changes:
- Server-side API may have changed
- Test agent data may have changed
- Dependencies updated

Re-test with `--all` to verify.

### Slow tests

The runner uses:
- **Concurrency**: 20 parallel tests (network-bound)
- **Caching**: Skip already-passing files
- **Direct Python**: No virtualenv activation overhead

If still slow:
- Test specific files with `--file`
- Check network connection to test agent
- Consider marking slow examples as `test=false`

## Integration with CI/CD

```bash
# In CI: always test everything from scratch
npm test -- --clear-cache

# Or test everything without cache file
npm test -- --all
```

Don't commit `.tested-files.json` - it's in `.gitignore`.
