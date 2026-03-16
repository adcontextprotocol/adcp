/**
 * GEO Prompt Monitor Job
 *
 * Periodically queries LLM APIs with standardized prompts and checks
 * whether AdCP/AgenticAdvertising.org gets mentioned in the responses.
 * Results are stored in geo_prompt_results for the GEO dashboard.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger as baseLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { ModelConfig } from '../../config/models.js';
import { syncGeoPromptsFromLLMPulse } from '../../services/geo-prompt-sync.js';

const logger = baseLogger.child({ module: 'geo-monitor' });

const ADCP_PATTERNS = [
  /\badcp\b/i,
  /ad context protocol/i,
  /agenticadvertising/i,
  /agentic advertising/i,
];

const COMPETITOR_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\baamp\b/i, name: 'AAMP' },
  { pattern: /agentic advertising management protocols/i, name: 'AAMP' },
  { pattern: /\bartf\b/i, name: 'ARTF' },
  { pattern: /agentic rtb framework/i, name: 'ARTF' },
  { pattern: /agentic audiences/i, name: 'Agentic Audiences' },
  { pattern: /iab tech lab agent registry/i, name: 'IAB Agent Registry' },
  { pattern: /iab tech lab/i, name: 'IAB Tech Lab' },
  { pattern: /\biab\b/i, name: 'IAB' },
  { pattern: /openrtb/i, name: 'OpenRTB' },
  { pattern: /prebid/i, name: 'Prebid' },
  { pattern: /google ads api/i, name: 'Google Ads API' },
  { pattern: /amazon ads api/i, name: 'Amazon Ads API' },
  { pattern: /unified id 2\.0|uid2/i, name: 'Unified ID 2.0' },
  { pattern: /the trade desk/i, name: 'The Trade Desk' },
];

const SYSTEM_PROMPT = 'Answer the user\'s question directly and concisely. Do not add disclaimers.';

/**
 * Rotate between Claude tiers on alternating weeks to get a broader
 * picture of how different model capabilities represent AdCP.
 */
function getModelForCurrentWeek(): string {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(
    ((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7
  );
  // Even weeks: fast (Haiku), odd weeks: primary (Sonnet)
  return weekNumber % 2 === 0 ? ModelConfig.fast : ModelConfig.primary;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Phrases that contain "agentic advertising" but refer to competitors,
 * not AdCP. Stripped before running ADCP_PATTERNS to avoid false positives.
 */
const COMPETITOR_PHRASES_TO_STRIP = [
  /agentic advertising management protocols/gi,
  /agentic audiences/gi,
  /agentic rtb framework/gi,
];

function detectAdcpMention(text: string): boolean {
  const cleaned = COMPETITOR_PHRASES_TO_STRIP.reduce(
    (t, p) => t.replace(p, ''),
    text
  );
  return ADCP_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function detectCompetitor(text: string): string | null {
  for (const { pattern, name } of COMPETITOR_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return null;
}

function detectSentiment(text: string, adcpMentioned: boolean): string {
  if (!adcpMentioned) {
    return 'neutral';
  }

  const lower = text.toLowerCase();
  const positiveSignals = [
    'leading', 'standard', 'widely adopted', 'recommended',
    'innovative', 'comprehensive', 'well-designed', 'promising',
  ];
  const negativeSignals = [
    'limited', 'not widely', 'early stage', 'lacks',
    'criticism', 'drawback', 'concern', 'competing',
  ];

  const positiveCount = positiveSignals.filter((s) => lower.includes(s)).length;
  const negativeCount = negativeSignals.filter((s) => lower.includes(s)).length;

  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}

interface GeoPrompt {
  id: number;
  prompt_text: string;
  category: string;
}

export async function runGeoMonitorJob(options: { limit?: number } = {}): Promise<{
  promptsChecked: number;
  mentions: number;
}> {
  const { limit } = options;

  try {
    const syncResult = await syncGeoPromptsFromLLMPulse();
    if (syncResult.configured) {
      logger.info(syncResult, 'Aligned GEO prompts with LLM Pulse before Claude monitor run');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to sync GEO prompts from LLM Pulse before monitor run');
  }

  // Fetch active prompts that haven't been checked in the last 7 days.
  // When no explicit limit is set, run the full synced inventory.
  const limitClause = limit != null ? 'LIMIT $1' : '';
  const promptsResult = await query<GeoPrompt>(
    `SELECT gp.id, gp.prompt_text, gp.category
     FROM geo_prompts gp
     WHERE gp.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM geo_prompt_results gpr
         WHERE gpr.prompt_id = gp.id
           AND gpr.checked_at > NOW() - INTERVAL '7 days'
       )
     ORDER BY gp.id
     ${limitClause}`,
    limit != null ? [limit] : []
  );

  const prompts = promptsResult.rows;

  if (prompts.length === 0) {
    logger.info('No prompts due for checking');
    return { promptsChecked: 0, mentions: 0 };
  }

  const model = getModelForCurrentWeek();
  logger.info({ count: prompts.length, model }, 'Checking GEO prompts');
  const anthropic = getClient();
  let mentions = 0;
  let checked = 0;

  for (const prompt of prompts) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt.prompt_text }],
      });

      const responseText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const adcpMentioned = detectAdcpMention(responseText);
      const competitorMentioned = detectCompetitor(responseText);
      const sentiment = detectSentiment(responseText, adcpMentioned);

      if (adcpMentioned) mentions++;

      await query(
        `INSERT INTO geo_prompt_results (prompt_id, model, response_text, adcp_mentioned, competitor_mentioned, sentiment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [prompt.id, model, responseText, adcpMentioned, competitorMentioned, sentiment]
      );

      checked++;

      logger.info(
        { promptId: prompt.id, category: prompt.category, adcpMentioned, competitorMentioned, sentiment },
        'Prompt checked'
      );

      // Rate limit: 2s between calls to avoid hitting API limits
      if (checked < prompts.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      logger.error({ error, promptId: prompt.id }, 'Failed to check prompt');
    }
  }

  logger.info({ checked, mentions }, 'GEO monitor job complete');

  return { promptsChecked: checked, mentions };
}
