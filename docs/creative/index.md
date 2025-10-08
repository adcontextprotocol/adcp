# Creative Protocol

A unified protocol for AI-powered creative generation that can produce either static creative manifests or dynamic executable code.

## Overview

The Creative Protocol enables two primary use cases:

1. **Creative Manifest Generation**: Build a creative manifest containing all assets, text, and metadata needed for traditional ad serving
2. **Dynamic Code Generation**: Generate executable HTML/JS code that renders creatives dynamically at runtime

Both modes use the same creative building workflow, differing only in the output format.

## Core Concepts

### Creative Building Process

The creative building process involves:
- Providing a creative brief in natural language
- Referencing assets from libraries (by ID or tags)
- Choosing output mode (manifest vs code)
- Iterating based on feedback using conversational refinement

### Output Modes

**Manifest Mode**: Returns a structured creative manifest with all assets and metadata
- Assets (images, videos, logos) with URLs
- Text content (headlines, descriptions, CTAs)
- Metadata and tracking information
- Can be rendered by any ad server
- Perfect for traditional programmatic workflows

**Code Mode**: Returns executable HTML/JavaScript code
- Handles its own rendering logic
- Supports real-time personalization
- Includes fallback mechanisms
- Best for dynamic campaigns with real-time optimization

### Asset Library Integration

Advertisers maintain a library of reusable assets that can be combined to create creatives:
- Brand assets (logos, colors, fonts)
- Stock imagery and video clips
- Audio tracks and voiceovers
- Templates and layouts
- Text components (headlines, CTAs)

Assets are organized using intelligent tagging for easy discovery and campaign reuse.

### Creative Formats

Each format defines:
- Technical specifications (dimensions, duration, file size)
- Required and optional asset types
- Composition rules and constraints
- Output options (static assets vs dynamic ad tags)

Formats can be either standard AdCP formats or publisher-specific custom formats.

## Getting Started

Ready to create your first creative? Check out our [Getting Started Guide](getting-started.md) for simple examples and common patterns.

## Advanced Topics

Advanced features like real-time inference, complex workflow patterns, and asset management best practices will be documented in future releases.

## Task Reference

- **[`build_creative`](task-reference/build_creative.md)**: Generate creative content with AI
- **[`manage_creative_library`](task-reference/manage_creative_library.md)**: Organize and search creative assets

## Integration

- **Integration with Media Buy Protocol**: Creative Protocol works seamlessly with Media Buy workflows
- **Cross-Platform Compatibility**: Generated creatives work across all major ad platforms
- **Performance Optimization**: Built-in best practices for creative performance

## Why Creative Agents?

Learn more about the [strategic value of creative agents](why-creative-agents.md) and how they transform advertising workflows.