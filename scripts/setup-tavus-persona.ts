/**
 * Creates an Addie persona in Tavus pointing at the local/production LLM endpoint.
 *
 * Usage:
 *   TAVUS_API_KEY=xxx BASE_URL=https://your-domain.com npx tsx scripts/setup-tavus-persona.ts
 *
 * The script prints the persona_id — add it to .env.local as TAVUS_PERSONA_ID.
 * Also set TAVUS_LLM_SECRET to the same value you provide here (used by the LLM endpoint).
 */

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const BASE_URL = process.env.BASE_URL ?? "https://agentic-advertising.org";
const LLM_SECRET = process.env.TAVUS_LLM_SECRET ?? "";

// Tavus stock replica (female presenter, neutral) — swap for a custom replica if desired.
// See: https://platform.tavus.io/replicas
const DEFAULT_REPLICA_ID = "rf4e9d9790f0";

if (!TAVUS_API_KEY) {
  console.error("TAVUS_API_KEY is required");
  process.exit(1);
}

const persona = {
  persona_name: "Addie",
  system_prompt:
    "You are Addie, the AI for AgenticAdvertising.org — the home of the Advertising Context Protocol (AdCP). " +
    "You help members, publishers, and agencies understand AdCP, navigate the community, and explore agentic advertising. " +
    "You are warm, knowledgeable, and direct. Keep responses concise for voice conversation.",
  pipeline_mode: "full",
  default_replica_id: DEFAULT_REPLICA_ID,
  layers: {
    llm: {
      model: "addie",
      base_url: `${BASE_URL}/api/addie/v1`,
      api_key: LLM_SECRET || "no-secret",
      speculative_inference: true,
    },
  },
};

const response = await fetch("https://tavusapi.com/v2/personas", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": TAVUS_API_KEY,
  },
  body: JSON.stringify(persona),
});

if (!response.ok) {
  const error = await response.text();
  console.error(`Failed (${response.status}): ${error}`);
  process.exit(1);
}

const result = await response.json() as { persona_id: string; persona_name: string };
console.log(`\nCreated persona: ${result.persona_name}`);
console.log(`persona_id: ${result.persona_id}`);
console.log(`\nAdd to .env.local:\n  TAVUS_PERSONA_ID=${result.persona_id}`);
if (LLM_SECRET) {
  console.log(`  TAVUS_LLM_SECRET=${LLM_SECRET}`);
}
