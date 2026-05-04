/**
 * Generate the Registry API OpenAPI spec from Zod schemas.
 *
 * Usage:  tsx scripts/generate-openapi.ts
 *
 * Imports the OpenAPI registry populated by registry-api.ts and writes
 * the generated spec to static/openapi/registry.yaml.
 */

import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import YAML from "yaml";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Import triggers route & schema registration
import "../server/src/routes/registry-api.js";
import "../server/src/schemas/member-agents-openapi.js";
import { registry } from "../server/src/schemas/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register security schemes. These must be registered on the registry —
// passing them via the generateDocument `components` option is silently
// dropped by OpenApiGeneratorV31, which emits only registered components.
registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: [
    "Bearer token in the `Authorization` header. Two token types are accepted:",
    "",
    "- **Organization API key** (`sk_...`) issued via the dashboard. Org-scoped, long-lived, for server-to-server use.",
    "- **User JWT** obtained via the OAuth 2.1 authorization code flow with PKCE. User-scoped, short-lived. Discover the authorization server at `/.well-known/oauth-authorization-server` and the protected-resource metadata at `/.well-known/oauth-protected-resource/api`.",
  ].join("\n"),
});

registry.registerComponent("securitySchemes", "oauth2", {
  type: "oauth2",
  description:
    "OAuth 2.1 authorization code flow with PKCE. Users authenticate via AuthKit and clients receive a Bearer JWT that authorizes both the MCP endpoint and this REST API. Dynamic client registration is supported at `/register`.",
  flows: {
    authorizationCode: {
      authorizationUrl: "https://agenticadvertising.org/authorize",
      tokenUrl: "https://agenticadvertising.org/token",
      refreshUrl: "https://agenticadvertising.org/token",
      scopes: {
        openid: "User identifier",
        profile: "User profile information",
        email: "User email address",
      },
    },
  },
});

const generator = new OpenApiGeneratorV31(registry.definitions);

const doc = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "AgenticAdvertising.org Registry API",
    description: [
      "REST API for the AgenticAdvertising.org registry. Resolve brands,",
      "discover properties, look up agents, and validate authorization in the",
      "AdCP ecosystem.",
      "",
      "Most endpoints are public and require no authentication. Endpoints marked",
      "with a lock icon accept either an organization API key or a user JWT",
      "obtained via the OAuth 2.1 flow — see [Authentication](https://agenticadvertising.org/docs/registry/index#authentication).",
      "",
      "**Base URL:** `https://agenticadvertising.org`",
    ].join("\n"),
    version: "1.0.0",
    contact: {
      name: "AgenticAdvertising.org",
      url: "https://agenticadvertising.org",
    },
  },
  servers: [
    {
      url: "https://agenticadvertising.org",
      description: "Production",
    },
  ],
  security: [],
});

// Tag descriptions for the generated spec.
// Mintlify renders nav groups in the order of this map, so "Member Agents"
// is intentionally first — it sits directly under the prose
// `Registering an agent` page in the side nav.
const TAG_DESCRIPTIONS: Record<string, string> = {
  "Member Agents": "Register, list, update, and remove agents on the caller's organization member profile. Authenticated programmatic surface for CI / scripts that don't want to round-trip the full member profile.",
  "Brand Resolution": "Resolve advertiser domains to canonical brand identities.",
  "Property Resolution": "Resolve publisher domains to their property configurations and authorized agents.",
  "Agent Discovery": "Browse the federated agent network, search agent inventory profiles, publisher index, and registry statistics.",
  "Change Feed": "Poll cursor-based registry change events for local sync.",
  "Lookups & Authorization": "Look up agents by domain or property, and validate ad-serving authorization.",
  "Validation Tools": "Validate publisher adagents.json files and generate compliant configurations.",
  "Search": "Cross-entity search across brands, publishers, agents, and properties.",
  "Agent Probing": "Connect to live agents and inspect their capabilities, formats, and inventory.",
  "Brand Discovery": "Discover and crawl brand.json files across domains.",
  "Agent Compliance": "Agent compliance status, storyboard test results, and compliance history.",
  "Policy Registry": "Browse, resolve, and contribute governance policies for campaign compliance.",
};

const TAG_ORDER = Object.keys(TAG_DESCRIPTIONS);

doc.tags = TAG_ORDER.map((name) => ({
  name,
  description: TAG_DESCRIPTIONS[name],
}));

// Remove empty sections the generator produces
if (doc.webhooks && Object.keys(doc.webhooks).length === 0) {
  delete doc.webhooks;
}
if ((doc.components as any)?.parameters && Object.keys((doc.components as any).parameters).length === 0) {
  delete (doc.components as any).parameters;
}

const yamlStr = YAML.stringify(doc, {
  lineWidth: 0, // Don't wrap long strings
  aliasDuplicateObjects: false,
});

const outPath = path.join(__dirname, "..", "static", "openapi", "registry.yaml");
fs.writeFileSync(outPath, yamlStr, "utf-8");
console.log(`OpenAPI spec written to ${outPath}`);
