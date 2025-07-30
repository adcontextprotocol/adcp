# Claude Development Guide

This guide helps AI assistants understand the AdCP project structure and maintain consistency when working on the codebase.

## Project Overview

The Advertising Context Protocol (AdCP) is an open standard for AI-powered advertising workflows. It provides a unified interface for media buying across diverse advertising platforms.

## Documentation Standards

### Protocol Specification vs Implementation

When working on documentation, it's crucial to maintain separation between:

1. **Protocol Specification** (what goes in docs/)
   - Abstract interface definitions
   - Tool signatures and parameters
   - Data models and schemas
   - Workflow descriptions
   - Platform-agnostic concepts

2. **Implementation Details** (what doesn't belong in the spec)
   - Database choices (PostgreSQL, MongoDB, etc.)
   - Deployment methods (Docker, Kubernetes, etc.)
   - Infrastructure details (multi-tenant architecture, etc.)
   - Specific technology stacks
   - Performance optimizations
   - Security implementation details

### Where Implementation Details Can Go

Implementation details can be mentioned as:
- **Recommendations** in a separate implementation guide
- **Examples** clearly marked as non-normative
- **Reference implementations** in the code
- **Best practices** documentation separate from the spec

### Writing Style

- Use "AdCP" not "ADCP"
- Focus on capabilities, not implementation
- Write for an audience implementing the protocol, not using a specific implementation
- Keep examples generic and illustrative

## Code Standards

### TypeScript/JavaScript
- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Implement proper error handling
- Add types for all parameters and return values

### Testing
- Check for existing test patterns before writing new tests
- Run tests with `npm test` before committing
- Ensure new features have corresponding tests

## Common Tasks

### Before Making Changes
1. Check `git status` to understand current state
2. Read relevant existing documentation
3. Search for similar patterns in the codebase
4. Consider impact on other parts of the system

### Documentation Updates
1. Keep protocol spec abstract and implementation-agnostic
2. Update all related documentation when making changes
3. Ensure examples are consistent across docs
4. Remove version numbers while in v1 development

### Code Changes
1. Follow existing patterns
2. Update tests
3. Run linting: `npm run lint`
4. Run type checking: `npm run typecheck`
5. Run tests: `npm test`

## Key Concepts to Remember

### Protocol Design Principles
1. **MCP-Based**: Built on Model Context Protocol
2. **Asynchronous**: Operations may take time
3. **Human-in-the-Loop**: Optional manual approval
4. **Platform Agnostic**: Works across ad platforms
5. **AI-Optimized**: Designed for AI agents

### What Exists vs What Doesn't
- ✅ `list_products` - discovers inventory
- ❌ `discover_products` - doesn't exist
- ❌ `get_avails` - removed in favor of direct purchase
- ✅ `create_media_buy` - creates campaigns
- ✅ `list_creative_formats` - shows supported formats

### Data Models
- Products don't include `targeting_template` or `implementation_config` in responses
- Focus on what's visible to API consumers, not internal implementation

## Useful Commands

```bash
# Development
npm run dev          # Start development server
npm run build        # Build the project
npm test            # Run tests
npm run lint        # Check code style
npm run typecheck   # Check TypeScript types

# Documentation
npm run docs:dev    # Start docs dev server
npm run docs:build  # Build documentation

# Git
git status          # Check current changes
git add -A          # Stage all changes
git commit -m "..."  # Commit with message
git push            # Push to remote
```

## When in Doubt

1. Check existing code for patterns
2. Keep the specification abstract
3. Focus on protocol capabilities, not implementation
4. Ask for clarification on design decisions
5. Refer to the [API Reference](docs/media-buy/api-reference.md) for tool signatures