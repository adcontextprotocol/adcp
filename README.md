# AdCP - Advertising Context Protocol

**Open standard for advertising automation across negotiation and serve-time decisioning**

[![Documentation](https://img.shields.io/badge/docs-adcontextprotocol.org-blue)](https://docs.adcontextprotocol.org)
[![GitHub stars](https://img.shields.io/github/stars/adcontextprotocol/adcp?style=social)](https://github.com/adcontextprotocol/adcp)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green)](https://modelcontextprotocol.io)

AdCP is an open standard that enables AI agents to discover inventory, buy media, build creatives, activate audiences, manage accounts, and activate pre-negotiated packages at serve time across advertising platforms. Planning-time tasks use [MCP](https://modelcontextprotocol.io) and [A2A](https://a2a-protocol.org/) transports; serve-time decisions use the Trusted Match HTTP profile where the latency budget is impression-time.

## Documentation

**[docs.adcontextprotocol.org](https://docs.adcontextprotocol.org)** — Full protocol specification, integration guides, and task reference.

## Protocol layers

AdCP is one protocol spanning two layers:

| Layer | Protocol surfaces | Purpose |
|-------|-------------------|---------|
| **Negotiation layer** | Media Buy, Creative, Signals, Accounts, Governance, Brand, Sponsored Intelligence | Discovery, planning, commercial setup, creative preparation, audience activation, governance, and reporting |
| **Decisioning and serving layer** | Trusted Match Protocol (Context Match, Identity Match) | Serve-time activation of pre-negotiated packages across web, mobile, CTV, AI assistants, and retail media |

| Surface | Description | Key tasks or schemas |
|---------|-------------|----------------------|
| **Media Buy** | Inventory discovery, campaign creation, delivery reporting | `get_products`, `create_media_buy`, `get_media_buy_delivery` |
| **Creative** | Ad creative management across channels | `build_creative`, `preview_creative`, `list_creative_formats` |
| **Signals** | Audience and targeting data activation | `get_signals`, `activate_signal` |
| **Accounts** | Commercial identity and billing | `sync_accounts`, `list_accounts`, `report_usage` |
| **Governance** | Brand suitability and content standards | `create_content_standards`, `calibrate_content` |
| **Brand** | Brand identity discovery and resolution | `brand.json` well-known file |
| **Sponsored Intelligence** | Conversational brand experiences | `si_initiate_session`, `si_send_message` |
| **Trusted Match** | Real-time execution layer for package activation | `trusted-match/context-match-request.json`, `trusted-match/identity-match-request.json` |
| **Curation** | Media inventory curation | Coming soon |

## Conformance and normativity

The schemas in `static/schemas/source/` and the protocol documents in `docs/` define the normative AdCP contract. The `server/` implementation is an illustrative registry/API/MCP implementation, not the specification. Conformance is measured independently by the grader and storyboards in `dist/compliance/`; the compliance runner tests any agent that claims the corresponding protocols or specialisms.

The AgenticAdvertising.org registry is ecosystem infrastructure around AdCP, not a task surface inside the protocol. It resolves brands and properties, discovers agents, and validates publisher authorization so buyers and orchestrators know which AdCP endpoints to call.

## Repository structure

```
adcontextprotocol/
├── docs/                  # Protocol documentation (Mintlify)
│   ├── media-buy/         # Media Buy protocol
│   ├── creative/          # Creative protocol
│   ├── signals/           # Signals protocol
│   ├── accounts/          # Accounts protocol
│   ├── governance/        # Governance protocol
│   ├── brand-protocol/    # Brand protocol
│   └── sponsored-intelligence/
├── server/                # Express server (registry, API, MCP)
│   ├── src/               # TypeScript source
│   └── public/            # Static pages (homepage, registry UI)
├── static/
│   ├── schemas/           # JSON schemas, including trusted-match serve-time schemas
│   └── openapi/           # OpenAPI specs
├── dist/
│   ├── schemas/           # Versioned release schema artifacts; use index.json/latest.json to resolve canonical versions
│   └── compliance/        # Versioned implementation-independent conformance grader artifacts
├── tests/                 # Schema validation and integration tests
└── scripts/               # Build and release tooling
```

## Local development

### Prerequisites

- Node.js 20+
- Docker

### Setup

```bash
npm install
docker compose up --build    # Starts PostgreSQL + app with auto-migrations
```

The server runs on port 3000. Docs run separately with `mintlify dev` on port 3333.

### Commands

```bash
npm test          # Run tests (schemas, examples, migrations)
npm run build     # Build TypeScript
npm run typecheck # Type check
npm run lint      # Lint
```

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines.

## JSON schemas

Schemas are available at `/schemas/latest/`:

- **Registry**: `/schemas/latest/index.json`
- **Core objects**: `/schemas/latest/core/*.json`
- **Task schemas**: `/schemas/latest/media-buy/*.json`, `/schemas/latest/signals/*.json`
- **Trusted Match**: `/schemas/latest/trusted-match/*.json`
- **Enums**: `/schemas/latest/enums/*.json`

See [static/schemas/README.md](./static/schemas/README.md) for validation examples.

## Governance

AdCP is a project of [AgenticAdvertising.Org](https://agenticadvertising.org), a pending 501(c)(6) nonprofit trade association incorporated in Delaware. The Foundation operates with four equally-weighted voting classes (brands, agencies, publishers, technology providers) and an open Working Group that develops AdCP. Reference sell-side implementation is maintained by the [Prebid](https://www.prebid.org/) community — spec governance (AAO) and reference-implementation development (Prebid) are intentionally separate organizations.

All contributions are under [Apache 2.0](./LICENSE), which includes an express patent grant from contributors. Examples in docs and test vectors use fictional brands only — see [CONTRIBUTING.md](./CONTRIBUTING.md).

- [CHARTER.md](./CHARTER.md) — Foundation structure, voting classes, Board, specification lifecycle, and conduct rules
- [IPR_POLICY.md](./IPR_POLICY.md) — Copyright, patent grants, trademark, and contribution terms
- [Working Groups](https://docs.adcontextprotocol.org/docs/community/working-group) — Each WG sets its own cadence; see the page for current meetings

## Contributing

We welcome contributions from platform providers, agencies, developers, and industry experts. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. All contributors must agree to the [IPR Policy](./IPR_POLICY.md).

## Community

- [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- [Working Groups](https://docs.adcontextprotocol.org/docs/community/working-group) — Each WG sets its own cadence; see the page for current meetings

## Links

- [Protocol documentation](https://docs.adcontextprotocol.org)
- [AgenticAdvertising.org](https://agenticadvertising.org) — Member organization
- [Release notes](https://docs.adcontextprotocol.org/docs/reference/release-notes)
- [Roadmap](https://docs.adcontextprotocol.org/docs/reference/roadmap)

## License

Licensed under [Apache 2.0](./LICENSE).
