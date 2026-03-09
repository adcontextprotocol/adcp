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

const logger = baseLogger.child({ module: 'geo-monitor' });

const ADCP_PATTERNS = [
  /adcp/i,
  /ad context protocol/i,
  /agenticadvertising/i,
  /agentic advertising/i,
];

const COMPETITOR_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /iab tech lab/i, name: 'IAB Tech Lab' },
  { pattern: /\biab\b/i, name: 'IAB' },
  { pattern: /openrtb/i, name: 'OpenRTB' },
];

const SYSTEM_PROMPT = 'Answer the user\'s question directly and concisely. Do not add disclaimers.';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

function detectAdcpMention(text: string): boolean {
  return ADCP_PATTERNS.some((pattern) => pattern.test(text));
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
  const { limit = 15 } = options;

  // Fetch active prompts that haven't been checked in the last 7 days
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
     LIMIT $1`,
    [limit]
  );

  const prompts = promptsResult.rows;

  if (prompts.length === 0) {
    logger.info('No prompts due for checking');
    return { promptsChecked: 0, mentions: 0 };
  }

  logger.info({ count: prompts.length }, 'Checking GEO prompts');

  const model = ModelConfig.fast;
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
    } catch (error) {
      logger.error({ error, promptId: prompt.id }, 'Failed to check prompt');
    }
  }

  logger.info({ checked, mentions }, 'GEO monitor job complete');

  return { promptsChecked: checked, mentions };
}
