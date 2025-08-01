# Ad Context Protocol

Open standards for AI-powered advertising workflows.

## Documentation

Visit [adcontextprotocol.github.io](https://adcontextprotocol.github.io) for full documentation.

## What is Ad Context Protocol?

Ad Context Protocol (AdCP) is an open standard that enables AI assistants to interact with advertising platforms through natural language. Built on the Model Context Protocol (MCP), AdCP allows marketers to discover signals (audiences, contextual, geographical, temporal data), curate inventory, and execute campaigns using conversational AI.

### Quick Example

Instead of navigating complex interfaces:

> "Find audience signals of premium sports enthusiasts who would be interested in high-end running shoes, and activate them on Scope3."

The AI assistant handles:
- Signal discovery across platforms
- Transparent pricing comparison  
- Direct activation on decisioning platforms

## Available Protocols

### 🎯 Signals Activation Protocol - RFC/v0.1
Discover and activate data signals using natural language.

- **Natural Language Discovery**: "High-income millennials interested in sustainable fashion" (audience signal)
- **Contextual Signals**: "Premium automotive content with high viewability"
- **Multi-Dimensional**: Combine geographical, temporal, and behavioral signals
- **Multi-Platform Activation**: Deploy across DSPs and data platforms
- **Transparent Pricing**: CPM and revenue share models
- **Real-time Status**: Track activation and deployment progress

### 📍 Curation Protocol - Coming Q2 2025
Curate media inventory based on context and brand safety requirements.

### 💰 Media Buy Protocol - RFC/v0.1  
Execute and optimize media buys programmatically across platforms.

## Quick Start

### For Platform Providers

Implement AdCP to enable AI-powered workflows for your customers:

1. **Review the Specification**: [Signals Protocol](https://adcontextprotocol.github.io/docs/signals/specification)
2. **Implement MCP Server**: Check out the [reference implementations](#reference-implementations)
3. **Test Your Implementation**: Use the validation test suite

### For Advertisers & Agencies

Use AdCP-enabled platforms with your AI assistant:

1. **Check Platform Support**: See which platforms support AdCP
2. **Configure Your AI**: Connect AdCP-enabled platforms to Claude, GPT, or other assistants
3. **Start Using**: Describe your marketing objectives in natural language

## Repository Structure

```
adcontextprotocol/
├── docs/                    # Documentation source files
│   ├── signals/            # Signals protocol docs
│   ├── curation/           # Curation protocol (coming soon)
│   ├── media-buy/          # Media Buy protocol docs
│   └── reference/          # API reference
├── src/                    # Website source files
└── README.md              # This file
```

## Community

### Working Group

Join our working group to help shape the future of advertising protocols:

- **Monthly Meetings**: First Wednesday of each month
- **GitHub Discussions**: [Join the conversation](https://github.com/adcontextprotocol/adcp/discussions)
- **Mailing List**: announcements@adcontextprotocol.org

### Contributing

We welcome contributions from:

- **Platform Providers**: Implement and improve protocols
- **Agencies & Advertisers**: Share use cases and feedback
- **Developers**: Contribute code, documentation, and examples
- **Industry Experts**: Help define standards and best practices

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Reference Implementations

- [Signals Agent](https://github.com/adcontextprotocol/signals-agent)
- [Sales Agent](https://github.com/adcontextprotocol/salesagent)

## Platform Implementations

### Current Support

- **Reference Implementation**: Complete MCP server example
- **Scope3**: Full Signals Activation Protocol support
- **More Coming**: Additional platforms implementing Q1 2025


## Documentation Website

This repository contains the documentation website built with [Docusaurus](https://docusaurus.io/).

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm start

# Build for production
npm run build
```

### Deployment

The site automatically deploys to GitHub Pages when changes are pushed to the main branch.

## License

The Ad Context Protocol specifications are licensed under [Apache 2.0](./LICENSE).

## Contact

- **General Inquiries**: hello@adcontextprotocol.org
- **Technical Support**: support@adcontextprotocol.org  
- **Security Issues**: security@adcontextprotocol.org
- **Partnership**: partnerships@adcontextprotocol.org

## Links

- **Website**: [adcontextprotocol.github.io](https://adcontextprotocol.github.io)
- **Specifications**: [Signals Protocol RFC](./signals-protocol-v1.md)
- **Discussions**: [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- **Issues**: [Report Issues](https://github.com/adcontextprotocol/adcp/issues)

---

Built with ❤️ by the advertising technology community.
