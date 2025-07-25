# Ad Context Protocol

Open standards for AI-powered advertising workflows.

## Documentation

Visit [adcontextprotocol.github.io](https://adcontextprotocol.github.io) for full documentation.

## What is Ad Context Protocol?

Ad Context Protocol (AdCP) is an open standard that enables AI assistants to interact with advertising platforms through natural language. Built on the Model Context Protocol (MCP), AdCP allows marketers to discover audiences, curate inventory, and execute campaigns using conversational AI.

### Quick Example

Instead of navigating complex interfaces:

> "Find audiences of premium sports enthusiasts who would be interested in high-end running shoes, and activate them on Scope3."

The AI assistant handles:
- Audience discovery across platforms
- Transparent pricing comparison  
- Direct activation on decisioning platforms

## Available Protocols

### 🎯 Audience Activation Protocol - RFC/v0.1
Discover and activate marketing audiences using natural language.

- **Natural Language Discovery**: "High-income millennials interested in sustainable fashion"
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

1. **Review the Specification**: [Audience Protocol RFC](./audience-protocol-v1.md)
2. **Implement MCP Server**: Follow the [implementation guide](https://adcontextprotocol.github.io/docs/implementation/getting-started)
3. **Test Your Implementation**: Use the validation test suite
4. **Get Certified**: Ensure your implementation meets quality standards.

### For Advertisers & Agencies

Use AdCP-enabled platforms with your AI assistant:

1. **Check Platform Support**: See which platforms support AdCP
2. **Configure Your AI**: Connect AdCP-enabled platforms to Claude, GPT, or other assistants
3. **Start Using**: Describe your marketing objectives in natural language

## Repository Structure

```
adcontextprotocol/
├── docs/                    # Documentation source files
│   ├── audience/           # Audience protocol docs
│   ├── implementation/     # Implementation guides  
│   └── reference/          # API reference
├── src/                    # Website source files
├── audience-protocol-v1.md # Protocol specification
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

## Platform Implementations

### Current Support

- **Reference Implementation**: Complete MCP server example
- **Scope3**: Full Audience Activation Protocol support
- **More Coming**: Additional platforms implementing Q1 2025

### Certification

Platform implementations can be certified for compliance and quality:

1. **Technical Compliance**: Pass validation test suite
2. **Performance Standards**: Meet response time requirements  
3. **Security Review**: Complete security assessment
4. **Documentation**: Provide complete integration docs

Learn more: [Certification Process](https://adcontextprotocol.github.io/docs/reference/certification)

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
- **Specifications**: [Audience Protocol RFC](./audience-protocol-v1.md)
- **Discussions**: [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- **Issues**: [Report Issues](https://github.com/adcontextprotocol/adcp/issues)

---

Built with ❤️ by the advertising technology community.
