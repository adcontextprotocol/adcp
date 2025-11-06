# Ad Context Protocol

[![Documentation](https://img.shields.io/badge/docs-adcontextprotocol.org-blue)](https://adcontextprotocol.org)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)
[![Discussions](https://img.shields.io/github/discussions/adcontextprotocol/adcontextprotocol)](https://github.com/adcontextprotocol/adcontextprotocol/discussions)

Open standards enabling AI assistants to interact with advertising platforms through natural language.

## 🚀 Overview

Ad Context Protocol (AdCP) provides standardized interfaces that allow AI assistants to:
- **Discover signals** (audiences, contextual, geographical, temporal) using natural language descriptions
- **Curate media inventory** based on campaign objectives
- **Execute media buys** with full transparency and control

Built on the Model Context Protocol (MCP), AdCP makes advertising platforms accessible to AI agents, revolutionizing how media buyers work.

## 📚 Documentation

Full documentation is available at [adcontextprotocol.org](https://adcontextprotocol.org)

### Quick Links
- [Getting Started](https://adcontextprotocol.org/docs/intro)
- [Signals Activation Protocol](https://adcontextprotocol.org/docs/signals)
- [Implementation Guide](https://adcontextprotocol.org/docs/implementation)
- [API Reference](https://adcontextprotocol.org/docs/reference)

## 🎯 Current Protocols

### Signals Activation Protocol (RFC/v0.1)
Enable AI assistants to discover and activate data signals across any compatible platform.

**Features:**
- Natural language signal discovery (audiences, contextual, geographical, temporal)
- Multi-dimensional signal combinations
- Multi-unit size reporting (individuals, devices, households)
- Flexible pricing models (CPM, revenue share)
- Automated activation and usage reporting

**Example:**
```
"Find affluent sports enthusiasts who would be interested in premium running shoes"
```

### Coming Soon
- **Curation Protocol** (Coming Soon) - Contextual inventory discovery
- **Media Buy Protocol** (RFC/v0.1) - Campaign execution and optimization

## 🛠 Implementation

### For Platform Providers

1. Review the protocol specification
2. Implement the MCP server following our guide
3. Validate with our test suite
4. Get listed in our directory

```typescript
// Example: Handling signal discovery
async function getSignals(prompt: string, platform: string) {
  // Your implementation here
  return {
    signals: [...],
    totalMatching: 47
  };
}
```

### For Developers

Install the TypeScript types (coming soon):
```bash
npm install @adcontextprotocol/types
```

## 🤝 Contributing

We welcome contributions! See our [Contributing Guide](CONTRIBUTING.md) for details.

### Ways to Contribute
- 🐛 Report bugs and issues
- 💡 Propose new features
- 📝 Improve documentation
- 🔧 Submit pull requests
- 💬 Join protocol discussions

## 🗺 Roadmap

- 🚧 **Now**: Signals Activation Protocol RFC/v0.1
- 🚧 **Now**: Media Buy Protocol RFC/v0.1
- 📅 **Coming Soon**: Curation Protocol RFC
- 🔮 **Q4 2025**: Advanced AI integrations

See our [detailed roadmap](https://github.com/adcontextprotocol/adcontextprotocol/projects/1) for more.

## 🏢 Who's Using AdCP?

- Platform providers implementing AdCP
- Agencies using AdCP for campaigns
- AI assistants with AdCP integration



## 📬 Get Involved

- **GitHub Discussions**: [Technical Q&A](https://github.com/adcontextprotocol/adcontextprotocol/discussions)
- **Working Group**: Monthly meetings (2nd Tuesday)
- **Email**: contact@adcontextprotocol.org
- **Blog**: [Latest updates](https://adcontextprotocol.org/blog)

## 📄 License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Ad Context Protocol is an industry initiative supported by:
- Advertising platforms committed to open standards
- Agencies seeking efficient workflows
- AI companies building the future

---

<p align="center">
  <strong>Ready to make advertising AI-native?</strong><br>
  <a href="https://adcontextprotocol.org/docs/intro">Get Started</a> •
  <a href="https://github.com/adcontextprotocol/adcontextprotocol/discussions">Join Discussion</a> •
  <a href="https://adcontextprotocol.org/docs/signals/specification">Read Spec</a>
</p>