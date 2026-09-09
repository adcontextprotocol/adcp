/**
 * Current Bolt declaration-superset prompt and tool declarations for matched v4.
 *
 * This module has no provider, tool-handler, selector, filesystem, or ledger
 * authority.  It deliberately derives its broad arm from registered Addie
 * definitions and its prompt from the production system-block builder.  The
 * sealed authority is the only consumer that can turn this data into a paid
 * request.
 */
import { createHash } from "node:crypto";
import { buildAddieRuntimeSystemBlocks } from "../claude-client.js";
import { buildModelToolDefinitions } from "../tool-wire-shape.js";
import { ADCP_TOOLS } from "../mcp/adcp-tools.js";
import { ADMIN_TOOLS } from "../mcp/admin-tools.js";
import { AUTH_GRADER_TOOLS } from "../mcp/auth-grader-tools.js";
import { BILLING_TOOLS } from "../mcp/billing-tools.js";
import { BRAND_CANONICAL_TOOLS } from "../mcp/brand-canonical-tools.js";
import { BRAND_PROPERTY_TOOLS } from "../mcp/brand-property-tools.js";
import { BRAND_TOOLS } from "../mcp/brand-tools.js";
import { CERTIFICATION_TOOLS } from "../mcp/certification-tools.js";
import { COLLABORATION_TOOLS } from "../mcp/collaboration-tools.js";
import { COMMITTEE_LEADER_TOOLS } from "../mcp/committee-leader-tools.js";
import { CONFORMANCE_TOOLS } from "../mcp/conformance-tools.js";
import { DIRECTORY_TOOLS } from "../mcp/directory-tools.js";
import { ESCALATION_TOOLS } from "../mcp/escalation-tools.js";
import { EVENT_ADMIN_TOOLS, EVENT_READONLY_TOOLS } from "../mcp/event-tools.js";
import { GOOGLE_DOCS_TOOLS } from "../mcp/google-docs.js";
import { ILLUSTRATION_TOOLS } from "../mcp/illustration-tools.js";
import { IMAGE_TOOLS } from "../mcp/image-tools.js";
import { KNOWLEDGE_TOOLS } from "../mcp/knowledge-search.js";
import { MEETING_TOOLS } from "../mcp/meeting-tools.js";
import { MEMBER_TOOLS } from "../mcp/member-tools.js";
import { NEWSLETTER_TOOLS } from "../mcp/newsletter-tools.js";
import { PORTRAIT_TOOLS } from "../mcp/portrait-tools.js";
import { PROPERTY_TOOLS } from "../mcp/property-tools.js";
import { SCHEMA_TOOLS } from "../mcp/schema-tools.js";
import { SI_HOST_TOOLS } from "../mcp/si-host-tools.js";
import { SOCIAL_DRAFT_TOOLS } from "../mcp/social-draft-tools.js";
import { URL_TOOLS } from "../mcp/url-tools.js";
import type {
  ModelProviderId,
  ModelSystemBlock,
  ModelToolDefinition,
} from "../model-providers/model-provider.js";
import type { AddieTool } from "../types.js";

export type AddieMatchedV4ToolSurface = "broad" | "clean";

/**
 * A small, fixed, capability-oriented surface.  It intentionally does not
 * use a trace, expected answer, or router result to select tools.
 */
export const ADDIE_MATCHED_V4_CLEAN_TOOL_NAMES = Object.freeze([
  "search_docs",
  "get_doc",
  "draft_github_issue",
  "create_github_issue",
  "list_certification_tracks",
  "get_certification_module",
  "get_learner_progress",
] as const);

const cleanToolNames = new Set<string>(ADDIE_MATCHED_V4_CLEAN_TOOL_NAMES);

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const key of Reflect.ownKeys(value)) {
    freeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function immutableTools(tools: readonly AddieTool[]): readonly AddieTool[] {
  return freeze(tools.map((tool) => structuredClone(tool)));
}

/**
 * Every current Bolt tool declaration, including capability-gated domains.
 *
 * This is deliberately a declaration superset—not a fictional privileged
 * caller and not a claim that every tool is executable together. The live
 * Slack assembly in bolt-app.ts performs identity, channel, feature-flag,
 * and handler-availability filtering. The evaluator therefore exposes this
 * arm only as a stable schema/prompt surface study and cannot promote it into
 * a production router-retirement decision without a separately sealed live
 * request-surface capture for the target persona.
 */
const BOLT_DECLARATION_SOURCES: readonly (readonly AddieTool[])[] = [
  MEMBER_TOOLS,
  SI_HOST_TOOLS,
  DIRECTORY_TOOLS,
  KNOWLEDGE_TOOLS,
  URL_TOOLS,
  GOOGLE_DOCS_TOOLS,
  ILLUSTRATION_TOOLS,
  BILLING_TOOLS,
  ESCALATION_TOOLS,
  NEWSLETTER_TOOLS,
  ADCP_TOOLS,
  AUTH_GRADER_TOOLS,
  CONFORMANCE_TOOLS,
  ADMIN_TOOLS,
  EVENT_READONLY_TOOLS,
  EVENT_ADMIN_TOOLS,
  MEETING_TOOLS,
  BRAND_TOOLS,
  BRAND_CANONICAL_TOOLS,
  BRAND_PROPERTY_TOOLS,
  COLLABORATION_TOOLS,
  SOCIAL_DRAFT_TOOLS,
  PORTRAIT_TOOLS,
  IMAGE_TOOLS,
  COMMITTEE_LEADER_TOOLS,
  PROPERTY_TOOLS,
  SCHEMA_TOOLS,
  CERTIFICATION_TOOLS,
];

function allBoltDeclarationToolDefinitions(): AddieTool[] {
  const definitions = new Map<string, AddieTool>();
  for (const source of BOLT_DECLARATION_SOURCES) {
    for (const definition of source) {
      const previous = definitions.get(definition.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(definition))
        throw new Error(`Conflicting current Bolt tool declaration: ${definition.name}`);
      if (!previous) definitions.set(definition.name, definition);
    }
  }
  return [...definitions.values()];
}

const broadToolManifest = immutableTools(allBoltDeclarationToolDefinitions());

/** The fixed minimal capability surface used for the paired ablation arm. */
const cleanToolManifest = (() => {
  const clean = broadToolManifest.filter((tool) => cleanToolNames.has(tool.name));
  if (clean.length !== ADDIE_MATCHED_V4_CLEAN_TOOL_NAMES.length) {
    throw new Error("Matched v4 clean production-representative tool manifest is incomplete");
  }
  return Object.freeze(clean);
})();

export function addieMatchedV4BroadToolManifest(): readonly AddieTool[] {
  return broadToolManifest;
}

export function addieMatchedV4CleanToolManifest(): readonly AddieTool[] {
  return cleanToolManifest;
}

export function addieMatchedV4ToolManifest(
  surface: AddieMatchedV4ToolSurface,
): readonly AddieTool[] {
  return surface === "broad"
    ? addieMatchedV4BroadToolManifest()
    : addieMatchedV4CleanToolManifest();
}

/**
 * Use Addie's normal prompt constructor.  Synthetic trace/receipt guardrails
 * are supplied later by the sealed evaluator, rather than being passed off as
 * production prompt text.  Request context and route-specific tool selection
 * remain intentionally absent: matched v4 is a synthetic, paired evaluation,
 * not a replay of a member request.
 */
function buildProductionPromptBlocks(
  surface: AddieMatchedV4ToolSurface,
): readonly ModelSystemBlock[] {
  const tools = addieMatchedV4ToolManifest(surface);
  return freeze(
    buildAddieRuntimeSystemBlocks({
      availableToolNames: tools.map((tool) => tool.name),
    }).map((block) => Object.freeze({ ...block })),
  );
}

const productionPromptBlocks = Object.freeze({
  broad: buildProductionPromptBlocks("broad"),
  clean: buildProductionPromptBlocks("clean"),
});

export function addieMatchedV4ProductionPromptBlocks(
  surface: AddieMatchedV4ToolSurface,
): readonly ModelSystemBlock[] {
  return productionPromptBlocks[surface];
}

export interface AddieMatchedV4WireSurface {
  readonly system: readonly ModelSystemBlock[];
  readonly tools: readonly ModelToolDefinition[];
  readonly provenance: Readonly<{
    surface: AddieMatchedV4ToolSurface | "router_no_tools";
    provider: ModelProviderId;
    toolCount: number;
    toolManifestSha256: string;
    systemBlocksSha256: string;
    promptAssembly: "buildAddieRuntimeSystemBlocks";
    representativeScope: "current_bolt_declaration_superset_with_synthetic_trace_context";
  }>;
}

function buildWireSurface(
  surface: AddieMatchedV4ToolSurface,
  provider: ModelProviderId,
): AddieMatchedV4WireSurface {
  // Cache hints are native Anthropic controls. OpenAI and Gemini do not
  // expose that control, so their exact frozen wire request omits it rather
  // than submitting a synthetic cross-provider approximation.
  const system = addieMatchedV4ProductionPromptBlocks(surface).map((block) =>
    provider === "anthropic" ? { ...block } : { text: block.text },
  );
  const tools = buildModelToolDefinitions(addieMatchedV4ToolManifest(surface)).map(
    (tool) => provider === "anthropic"
      ? { ...tool }
      : (({ cacheHint: _cacheHint, ...wire }) => wire)(tool),
  );
  return freeze({
    system,
    tools,
    provenance: {
      surface,
      provider,
      toolCount: tools.length,
      toolManifestSha256: digest(tools),
      systemBlocksSha256: digest(system),
      promptAssembly: "buildAddieRuntimeSystemBlocks",
      representativeScope: "current_bolt_declaration_superset_with_synthetic_trace_context",
    },
  });
}

const wireSurfaces = freeze({
  anthropic: {
    broad: buildWireSurface("broad", "anthropic"),
    clean: buildWireSurface("clean", "anthropic"),
  },
  openai: {
    broad: buildWireSurface("broad", "openai"),
    clean: buildWireSurface("clean", "openai"),
  },
  google: {
    broad: buildWireSurface("broad", "google"),
    clean: buildWireSurface("clean", "google"),
  },
});

function buildRouterWireSurface(provider: ModelProviderId): AddieMatchedV4WireSurface {
  const system = buildAddieRuntimeSystemBlocks({ availableToolNames: [] }).map((block) =>
    provider === "anthropic" ? { ...block } : { text: block.text },
  );
  const tools: ModelToolDefinition[] = [];
  return freeze({
    system,
    tools,
    provenance: {
      surface: "router_no_tools",
      provider,
      toolCount: 0,
      toolManifestSha256: digest(tools),
      systemBlocksSha256: digest(system),
      promptAssembly: "buildAddieRuntimeSystemBlocks",
      representativeScope: "current_bolt_declaration_superset_with_synthetic_trace_context",
    },
  });
}

const routerWireSurfaces = freeze({
  anthropic: buildRouterWireSurface("anthropic"),
  openai: buildRouterWireSurface("openai"),
  google: buildRouterWireSurface("google"),
});

export function addieMatchedV4WireSurface(
  surface: AddieMatchedV4ToolSurface,
  provider: ModelProviderId,
): AddieMatchedV4WireSurface {
  return wireSurfaces[provider][surface];
}

export function addieMatchedV4RouterWireSurface(
  provider: ModelProviderId,
): AddieMatchedV4WireSurface {
  return routerWireSurfaces[provider];
}

/** Stable identity of every provider-specific exact wire projection. */
export function addieMatchedV4WireSurfaceProvenance(): readonly AddieMatchedV4WireSurface["provenance"][] {
  return freeze((Object.keys(wireSurfaces) as ModelProviderId[]).flatMap((provider) => [
    wireSurfaces[provider].broad.provenance,
    wireSurfaces[provider].clean.provenance,
    routerWireSurfaces[provider].provenance,
  ]));
}

export function addieMatchedV4RuntimeSurfaceProvenance(
  surface: AddieMatchedV4ToolSurface,
): Readonly<{
  surface: AddieMatchedV4ToolSurface;
  toolCount: number;
  toolManifestSha256: string;
  productionPromptBlocksSha256: string;
  promptAssembly: "buildAddieRuntimeSystemBlocks";
  representativeScope: "current_bolt_declaration_superset_with_synthetic_trace_context";
}> {
  const tools = addieMatchedV4ToolManifest(surface);
  const prompt = addieMatchedV4ProductionPromptBlocks(surface);
  return Object.freeze({
    surface,
    toolCount: tools.length,
    toolManifestSha256: digest(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }))),
    productionPromptBlocksSha256: digest(prompt.map((block) => ({
      text: block.text,
      ...(block.cacheHint ? { cacheHint: block.cacheHint } : {}),
    }))),
    promptAssembly: "buildAddieRuntimeSystemBlocks",
    representativeScope: "current_bolt_declaration_superset_with_synthetic_trace_context",
  });
}
