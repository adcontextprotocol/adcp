/**
 * GEO Content Planner Job
 *
 * Analyzes GEO monitoring results to identify content gaps and generates
 * content briefs for pages that could improve LLM visibility.
 *
 * Runs weekly after the geo-monitor job. For each prompt where
 * adcp_mentioned = false, it checks whether an existing doc page should
 * answer that query. If not, it creates a content brief.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../../logger.js";
import { query } from "../../db/client.js";
import { ModelConfig } from "../../config/models.js";

const logger = createLogger("geo-content-planner");

interface UnmentionedPrompt {
  prompt_id: number;
  prompt_text: string;
  category: string;
  latest_response: string;
  competitor_mentioned: string | null;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Known doc pages that map to prompt categories.
 * Used to check whether a content gap already has a target page.
 */
const CATEGORY_PAGE_MAP: Record<string, string[]> = {
  brand: [
    "docs/intro.mdx",
    "docs/guides/how-agents-communicate.mdx",
  ],
  competitive: [
    "docs/building/understanding/adcp-vs-openrtb.mdx",
    "docs/building/understanding/protocol-comparison.mdx",
  ],
  intent: [
    "docs/guides/seller-integration.mdx",
    "docs/guides/ai-media-buying.mdx",
  ],
  buyer: [
    "docs/guides/ai-media-buying.mdx",
    "docs/guides/commerce-media.mdx",
  ],
  executive: [
    "docs/guides/industry-landscape.mdx",
  ],
  audience: [
    "docs/signals/data-providers.mdx",
    "docs/signals/specification.mdx",
  ],
  canary: [
    "docs/faq.mdx",
  ],
};

export async function runGeoContentPlannerJob(options: {
  limit?: number;
} = {}): Promise<{
  promptsAnalyzed: number;
  briefsCreated: number;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info("ANTHROPIC_API_KEY not configured, skipping content planner");
    return { promptsAnalyzed: 0, briefsCreated: 0 };
  }

  const { limit = 10 } = options;

  // Find prompts where the most recent check returned adcp_mentioned = false
  // and no brief exists yet for that prompt
  const result = await query<UnmentionedPrompt>(
    `SELECT
       gp.id AS prompt_id,
       gp.prompt_text,
       gp.category,
       gpr.response_text AS latest_response,
       gpr.competitor_mentioned
     FROM geo_prompts gp
     JOIN geo_prompt_results gpr ON gpr.prompt_id = gp.id
     WHERE gp.is_active = true
       AND gpr.adcp_mentioned = false
       AND gpr.checked_at = (
         SELECT MAX(checked_at) FROM geo_prompt_results WHERE prompt_id = gp.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM geo_content_briefs gcb
         WHERE gcb.prompt_id = gp.id
           AND gcb.status IN ('draft', 'approved', 'published')
       )
     ORDER BY gp.category, gp.id
     LIMIT $1`,
    [limit]
  );

  const prompts = result.rows;
  if (prompts.length === 0) {
    logger.info("No unaddressed content gaps found");
    return { promptsAnalyzed: 0, briefsCreated: 0 };
  }

  logger.info({ count: prompts.length }, "Analyzing content gaps");

  const anthropic = getClient();
  let briefsCreated = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    try {
      const existingPages = CATEGORY_PAGE_MAP[prompt.category] || [];
      const suggestedPath = existingPages[0] || null;

      const safePromptText = prompt.prompt_text.slice(0, 500);
      const safeCompetitor = prompt.competitor_mentioned?.slice(0, 100) ?? null;

      const briefResponse = await anthropic.messages.create({
        model: ModelConfig.fast,
        max_tokens: 512,
        system: `You generate content briefs for documentation pages. Be concise and specific. Output only the brief — no preamble.`,
        messages: [
          {
            role: "user",
            content: `A user asked an LLM: "${safePromptText}"

The LLM's response did NOT mention AdCP or AgenticAdvertising.org.${safeCompetitor ? ` It mentioned ${safeCompetitor} instead.` : ""}

Category: ${prompt.category}
${suggestedPath ? `Existing page that should answer this: ${suggestedPath}` : "No existing page covers this topic."}

Write a content brief (3-5 bullet points) describing what content would help an LLM answer this query with an accurate mention of AdCP. Focus on:
- What specific information should the page contain
- What H2/H3 headings would match this query
- What facts about AdCP are relevant to this query`,
          },
        ],
      });

      const briefText = briefResponse.content
        .filter(
          (block): block is Anthropic.TextBlock => block.type === "text"
        )
        .map((block) => block.text)
        .join("\n");

      await query(
        `INSERT INTO geo_content_briefs
          (prompt_id, prompt_category, target_query, suggested_page_path, brief, status)
         VALUES ($1, $2, $3, $4, $5, 'draft')`,
        [
          prompt.prompt_id,
          prompt.category,
          prompt.prompt_text,
          suggestedPath,
          briefText,
        ]
      );

      briefsCreated++;

      logger.info(
        {
          promptId: prompt.prompt_id,
          category: prompt.category,
          suggestedPath,
        },
        "Content brief created"
      );
    } catch (error) {
      logger.error(
        { error, promptId: prompt.prompt_id },
        "Failed to generate content brief"
      );
    }

    // Rate limit between Claude calls
    if (i < prompts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  logger.info(
    { analyzed: prompts.length, created: briefsCreated },
    "GEO content planner complete"
  );

  return { promptsAnalyzed: prompts.length, briefsCreated };
}
