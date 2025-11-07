# AdCP - Open Standard for Advertising Automation

**Unified advertising automation protocol built on Model Context Protocol (MCP)**

[![GitHub stars](https://img.shields.io/github/stars/adcontextprotocol/adcp?style=social)](https://github.com/adcontextprotocol/adcp)
[![Documentation](https://img.shields.io/badge/docs-adcontextprotocol.org-blue)](https://adcontextprotocol.org)
[![npm version](https://img.shields.io/npm/v/@adcp/client)](https://www.npmjs.com/package/@adcp/client)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green)](https://modelcontextprotocol.io)

> **AdCP revolutionizes advertising automation by providing a single, AI-powered protocol that works across all major advertising platforms.**

## Documentation

Visit [adcontextprotocol.org](https://adcontextprotocol.org) for full documentation.

## What is AdCP?

Ad Context Protocol (AdCP) is an **open standard for advertising automation** that enables AI assistants to interact with advertising platforms through natural language. Built on the Model Context Protocol (MCP), AdCP provides:

- 🔌 **Unified Advertising API** - Single interface for all advertising platforms
- 🤖 **AI-Powered Automation** - Built for natural language campaign management
- 📊 **Cross-Platform Analytics** - Standardized reporting across all platforms  
- 🔓 **Open Standard** - No vendor lock-in, community-driven development
- ⚡ **Programmatic Ready** - Designed for modern ad tech workflows

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

### 📍 Curation Protocol - Coming Soon
Curate media inventory based on context and brand safety requirements.

### 💰 Media Buy Protocol - RFC/v0.1  
Execute and optimize media buys programmatically across platforms.

## Quick Start

### Install Client Libraries

#### JavaScript/TypeScript
```bash
npm install @adcp/client
```
- **NPM Package**: [@adcp/client](https://www.npmjs.com/package/@adcp/client)
- **GitHub**: [adcp-client](https://github.com/adcontextprotocol/adcp-client)

#### Python
Python client library is in development. For now, use the Model Context Protocol Python SDK:
```bash
pip install mcp
```
- **GitHub**: [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- **Examples**: See our [reference implementations](https://github.com/adcontextprotocol)

### For Platform Providers

Implement AdCP to enable AI-powered workflows for your customers:

1. **Review the Specification**: [Signals Protocol](https://adcontextprotocol.org/docs/signals/specification)
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

## Use Cases

### For Advertising Technology Companies
- Build unified advertising automation tools
- Integrate with multiple platforms through single API
- Enable AI-powered advertising workflows
- Create MCP-compatible advertising servers

### For Agencies and Advertisers  
- Automate campaign management across all platforms
- Use natural language for advertising operations
- Get unified analytics and reporting
- Reduce integration and maintenance costs

### For Publishers and Ad Networks
- Expose inventory through standardized protocol
- Enable AI assistant integration
- Participate in automated advertising ecosystem
- Implement once, work with all AI tools

## Keywords

`advertising automation`, `programmatic advertising API`, `MCP advertising integration`, `AI advertising workflows`, `unified advertising platform API`, `advertising protocol standard`, `Model Context Protocol advertising`, `cross-platform advertising automation`

## Links

- **Website**: [adcontextprotocol.org](https://adcontextprotocol.org)
- **API Documentation**: [Advertising Automation API](https://adcontextprotocol.org/advertising-automation-api)
- **MCP Integration**: [MCP Advertising Guide](https://adcontextprotocol.org/mcp-advertising-integration)
- **Specifications**: [Signals Protocol RFC](docs/signals/specification.mdx)
- **Discussions**: [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- **Issues**: [Report Issues](https://github.com/adcontextprotocol/adcp/issues)

---

Built with ❤️ by the advertising technology community.
