# Mintlify Documentation Enhancements

This document describes the Mintlify-specific features we can use to enhance AdCP documentation.

## Features Implemented

### 1. Reusable Snippets

Created in `snippets/` directory - these prevent duplication and ensure consistency.

#### Available Snippets

**`test-agent-credentials.mdx`**
- Test agent URL and credentials for both MCP and A2A
- Tabbed interface for protocol selection
- Usage notes and warnings
- **Use in**: Any page showing examples with the test agent

**`install-libraries.mdx`**
- Installation instructions for all package managers (npm, pip, yarn, pnpm)
- Card links to NPM and PyPI packages
- **Use in**: Quickstart, integration guides, task references

**`client-setup.mdx`**
- Client initialization code for JavaScript and Python
- Side-by-side comparison in CodeGroup
- **Use in**: Quickstart, task examples, integration guides

**`example-get-products.mdx`**
- Complete working example with JavaScript, Python, and cURL
- Line highlighting (lines 6-8) to emphasize key parts
- Accordion with expected response
- **Use in**: Quickstart, get_products task reference

**`common-errors.mdx`**
- Exportable error objects for reuse
- Accordion group with common authentication errors
- Resolution steps for each error
- **Use in**: Error handling docs, task references, troubleshooting

### 2. Enhanced Code Blocks

Mintlify code blocks support powerful features we can use:

#### Line Highlighting
```javascript {6-8}
// Highlights lines 6-8
const result = await client.getProducts({
  promoted_offering: 'Premium athletic footwear'
});
```

#### Diff Visualization
```javascript
function oldFunction() {
  return 'old'; // [!code --]
  return 'new'; // [!code ++]
}
```

#### Titles and Icons
```javascript title="client-setup.js" icon="node"
import { AdcpClient } from '@adcp/client';
```

#### Code Groups (Multiple Languages)
```javascript JavaScript
// JavaScript version
```
```python Python
# Python version
```
```bash cURL
# cURL version
```

### 3. Interactive Components

**Tabs**: Protocol selection, language selection, different approaches
**Accordions**: Collapsible details, FAQs, error reference
**Cards**: Feature highlights, next steps, resource links
**Steps**: Sequential instructions, setup guides
**Callouts**: Info, Warning, Tip, Note, Check blocks

## How to Use in Documentation

### Import Snippets

```mdx
---
title: Your Page
---

import TestAgentCredentials from '/snippets/test-agent-credentials.mdx';
import BasicExample from '/snippets/example-get-products.mdx';

# Your Page

<TestAgentCredentials />

## Example

<BasicExample />
```

### Update Existing Code Blocks

**Before:**
```markdown
\`\`\`javascript
const client = new AdcpClient({...});
\`\`\`
```

**After (with line highlighting):**
```markdown
\`\`\`javascript {2-4}
const client = new AdcpClient({
  agentUrl: 'https://test-agent.adcontextprotocol.org/mcp',
  protocol: 'mcp',
  bearerToken: 'token-here'
});
\`\`\`
```

### Replace Repeated Content

**Before:** Test agent credentials copied in 15+ files

**After:**
```mdx
import TestAgentCredentials from '/snippets/test-agent-credentials.mdx';

<TestAgentCredentials />
```

## Benefits

### For Documentation Maintainers
- ✅ **Single source of truth** - Update credentials once, reflected everywhere
- ✅ **Consistency** - All examples use the same patterns
- ✅ **Less repetition** - DRY principle for docs
- ✅ **Easier updates** - Change snippet once instead of 15+ files

### For Users
- ✅ **Better readability** - Tabs, accordions, cards make content scannable
- ✅ **Multiple languages** - See examples in their preferred language
- ✅ **Interactive** - Copy code, expand details, switch tabs
- ✅ **Visual hierarchy** - Icons, colors, callouts guide attention

### For Testing
- ✅ **Testable snippets** - Can mark snippet files with test=true
- ✅ **Centralized examples** - One place to update and test
- ✅ **Version control** - Track changes to common patterns

## Implementation Plan

### Phase 1: Create Core Snippets (✅ Complete)
- [x] Test agent credentials
- [x] Library installation
- [x] Client setup
- [x] Basic get_products example
- [x] Common errors

### Phase 2: Enhance Quickstart
- [ ] Replace quickstart.mdx with quickstart-enhanced.mdx
- [ ] Test all interactive components
- [ ] Verify snippet imports work

### Phase 3: Update Task References
- [ ] Add snippets to all task reference pages
- [ ] Use CodeGroups for multi-language examples
- [ ] Add line highlighting to emphasize key code

### Phase 4: Enhance Error Documentation
- [ ] Import common-errors snippet
- [ ] Add accordions for error categories
- [ ] Link errors to resolution guides

### Phase 5: Update Integration Guides
- [ ] Use client-setup snippet consistently
- [ ] Add Step components for sequential instructions
- [ ] Use Cards for feature highlights

## Example: Enhanced Quickstart

See `docs/quickstart-enhanced.mdx` for a complete example using:
- Imported snippets (credentials, installation, setup)
- CodeGroups (multi-language examples)
- Tabs (public vs authenticated operations, MCP vs A2A)
- Accordions (collapsible details)
- Cards (visual navigation)
- Steps (sequential instructions)
- Callouts (Info, Warning, Tip, Note, Check)

## Testing Snippets

Snippets can be tested like any other documentation:

```markdown
\`\`\`javascript test=true
// This code in a snippet file will be tested
const result = await client.getProducts({...});
\`\`\`
```

The snippet validation tool will extract and test these blocks.

## Migration Strategy

### Low Risk - Quick Wins
1. Create snippets for most-repeated content
2. Update 2-3 high-traffic pages (quickstart, main task reference)
3. Gather feedback on readability

### Medium Risk - Gradual Rollout
4. Update remaining task reference pages
5. Enhance error documentation
6. Update integration guides

### High Value - Long Term
7. Create snippet library for all common patterns
8. Document snippet usage in contributor guide
9. Add snippet coverage metrics

## Maintenance

### When to Update Snippets
- API changes affecting credentials or setup
- New features requiring updated examples
- User feedback on clarity or completeness

### When to Create New Snippets
- Content appears in 3+ places
- Complex example used multiple times
- Standard pattern that should be consistent

### When NOT to Use Snippets
- Page-specific content
- One-off examples
- Rapidly changing experimental features

## Resources

- [Mintlify Code Blocks](https://www.mintlify.com/docs/create/code)
- [Mintlify Reusable Snippets](https://www.mintlify.com/docs/create/reusable-snippets)
- [Mintlify Components](https://www.mintlify.com/docs/create/components)
