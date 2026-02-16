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
import { registry } from "../server/src/schemas/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const generator = new OpenApiGeneratorV31(registry.definitions);

const doc = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "AgenticAdvertising.org Registry API",
    description: [
      "Public REST API for the AgenticAdvertising.org registry. Resolve brands,",
      "discover properties, look up agents, and validate authorization in the",
      "AdCP ecosystem.",
      "",
      "All endpoints listed here are public and require no authentication.",
      "",
      "**Base URL:** `https://agenticadvertising.org`",
      "",
      "**Rate limits:** Bulk resolve endpoints are limited to 20 requests per minute",
      "per IP address. All other endpoints are unmetered.",
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

// Tag descriptions for the generated spec
const TAG_DESCRIPTIONS: Record<string, string> = {
  "Brand Resolution": "Resolve advertiser domains to canonical brand identities.",
  "Property Resolution": "Resolve publisher domains to their property configurations and authorized agents.",
  "Agent Discovery": "Browse the federated agent network, publisher index, and registry statistics.",
  "Lookups & Authorization": "Look up agents by domain or property, and validate ad-serving authorization.",
  "Validation Tools": "Validate publisher adagents.json files and generate compliant configurations.",
  "Search": "Cross-entity search across brands, publishers, agents, and properties.",
  "Agent Probing": "Connect to live agents and inspect their capabilities, formats, and inventory.",
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
