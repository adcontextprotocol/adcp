/**
 * Social Post Ideas Job
 *
 * Runs on Wednesday and Friday mornings (ET). Picks the best unposted
 * article from addie_knowledge and generates ready-to-share social copy
 * angled toward AdCP advantages. Posts to #social-post-ideas Slack channel.
 *
 * Content selection:
 * - quality_score >= 4
 * - Prioritizes mentions_adcp, then mentions_agentic, then by quality
 * - Only articles not yet turned into social posts
 *
 * Output per article:
 * - 2 LinkedIn post variants (different rhetorical strategies)
 * - 1 X/Twitter post (under 280 chars)
 */

import { createLogger } from '../../logger.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import { query } from '../../db/client.js';
import { sendChannelMessage } from '../../slack/client.js';

const logger = createLogger('social-post-ideas');

const SOCIAL_POST_IDEAS_CHANNEL = process.env.SOCIAL_POST_IDEAS_CHANNEL_ID;

/** Slack mrkdwn section blocks have a 3000-char limit */
const SLACK_BLOCK_TEXT_LIMIT = 2900;

interface SocialPostArticle {
  id: number;
  title: string;
  source_url: string;
  summary: string;
  addie_notes: string;
  quality_score: number;
  mentions_agentic: boolean;
  mentions_adcp: boolean;
  relevance_tags: string[];
}

interface SocialPostIdeas {
  angle: string;
  linkedin_a: string;
  linkedin_b: string;
  twitter: string;
  topical_hashtag: string;
}

export interface SocialPostIdeasResult {
  posted: boolean;
  skipped: boolean;
  articleId?: number;
  error?: string;
}

/**
 * Get the current hour in US Eastern time
 */
function getETHour(): number {
  const now = new Date();
  const etString = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(etString, 10);
}

/**
 * Get the current day of week in US Eastern time
 */
function getETDayOfWeek(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(new Date());
}

/**
 * Truncate text to fit within Slack block limits
 */
function truncateForSlackBlock(text: string): string {
  if (text.length <= SLACK_BLOCK_TEXT_LIMIT) return text;
  return text.slice(0, SLACK_BLOCK_TEXT_LIMIT) + '...';
}

/**
 * Main job runner. Runs hourly but only acts on Wed/Fri 8-9 AM ET.
 */
export async function runSocialPostIdeasJob(): Promise<SocialPostIdeasResult> {
  const result: SocialPostIdeasResult = { posted: false, skipped: false };

  const day = getETDayOfWeek();
  if (day !== 'Wed' && day !== 'Fri') {
    return result;
  }

  const hour = getETHour();
  if (hour < 8 || hour >= 9) {
    return result;
  }

  if (!SOCIAL_POST_IDEAS_CHANNEL) {
    logger.debug('SOCIAL_POST_IDEAS_CHANNEL_ID not set, skipping');
    result.skipped = true;
    return result;
  }

  if (!isLLMConfigured()) {
    logger.debug('LLM not configured, skipping');
    result.skipped = true;
    return result;
  }

  // Idempotency: only one post per day
  const alreadyPostedToday = await query(
    `SELECT 1 FROM addie_knowledge
     WHERE social_post_generated_at >= CURRENT_DATE
     LIMIT 1`,
  );
  if (alreadyPostedToday.rows.length > 0) {
    logger.debug('Already posted social ideas today, skipping');
    return result;
  }

  // Pick the best unposted article
  const article = await getBestUnpostedArticle();
  if (!article) {
    logger.debug('No articles available for social post ideas');
    result.skipped = true;
    return result;
  }

  // Generate social post copy
  const ideas = await generateSocialPosts(article);
  if (!ideas) {
    result.skipped = true;
    result.error = 'Failed to generate social posts';
    return result;
  }

  // Post to Slack
  const posted = await postToChannel(article, ideas);
  if (posted) {
    // Mark article as used
    await query(
      `UPDATE addie_knowledge SET social_post_generated_at = NOW() WHERE id = $1`,
      [article.id],
    );
    result.posted = true;
    result.articleId = article.id;
    logger.info({ articleId: article.id, title: article.title }, 'Posted social post ideas');
  }

  return result;
}

/**
 * Get the best article that hasn't been turned into a social post yet.
 * Prioritizes: mentions_adcp > mentions_agentic > quality_score > recency
 */
async function getBestUnpostedArticle(): Promise<SocialPostArticle | null> {
  const result = await query<SocialPostArticle>(
    `SELECT id, title, source_url, summary, addie_notes, quality_score,
            mentions_agentic, mentions_adcp, relevance_tags
     FROM addie_knowledge
     WHERE fetch_status = 'success'
       AND quality_score >= 4
       AND social_post_generated_at IS NULL
       AND created_at > NOW() - INTERVAL '14 days'
     ORDER BY
       mentions_adcp DESC,
       mentions_agentic DESC,
       quality_score DESC,
       created_at DESC
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

/**
 * Query recent social post ideas for use in the weekly digest.
 * Returns articles that were posted to #social-post-ideas in the last 7 days.
 */
export async function getRecentSocialPostIdeas(days: number = 7, limit: number = 2): Promise<SocialPostArticle[]> {
  const result = await query<SocialPostArticle>(
    `SELECT id, title, source_url, summary, addie_notes, quality_score,
            mentions_agentic, mentions_adcp, relevance_tags
     FROM addie_knowledge
     WHERE social_post_generated_at IS NOT NULL
       AND social_post_generated_at > NOW() - INTERVAL '1 day' * $1
     ORDER BY social_post_generated_at DESC
     LIMIT $2`,
    [days, limit],
  );
  return result.rows;
}

/**
 * Generate social post copy using Claude, angled toward AdCP advantages.
 * System instructions are separated from article data to mitigate prompt injection.
 */
async function generateSocialPosts(article: SocialPostArticle): Promise<SocialPostIdeas | null> {
  const system = `You are writing social media posts for members of AgenticAdvertising.org to share on their personal accounts. The goal is to position AdCP (Ad Context Protocol) and agentic advertising as the future of the industry.

Generate social posts that connect the provided article to one of these AdCP advantages:
- Protocol-level interoperability vs. walled gardens
- AI-native advertising vs. bolted-on automation
- Open standard vs. proprietary lock-in
- Buyer/seller transparency through shared protocol

**Rules:**
- Write as a knowledgeable ad tech practitioner, NOT a corporate account
- Confident but not combative. Specific over abstract.
- The member should look smart and plugged-in, not like they're doing PR
- React to the article, don't summarize it. The reader should learn something from the post itself, not just be pointed at the link.
- Do NOT open with "Just read..." or "Interesting article..." -- lead with the idea, not the act of reading
- Do NOT end with engagement-bait questions ("What do you think?", "Am I the only one?", "Agree or disagree?")
- Place the article URL after the main argument and before the hashtags. Don't embed it mid-sentence.
- No placeholder text -- everything should be paste-ready
- Max 3 hashtags: #AdCP + #AgenticAdvertising + 1 topical hashtag you pick

**LinkedIn option A** should connect the article's specific finding to a practical AdCP use case the reader can picture. (800-1200 chars)

**LinkedIn option B** should identify what the article gets wrong or misses, then explain what AdCP changes about the picture. (800-1200 chars)

**X/Twitter** must be under 280 chars total. URLs count as 23 chars on X (t.co wrapping). Include article URL and at least #AdCP.

Return JSON:
{
  "angle": "1 sentence: what AdCP advantage this highlights",
  "linkedin_a": "LinkedIn post option A",
  "linkedin_b": "LinkedIn post option B",
  "twitter": "X/Twitter post",
  "topical_hashtag": "one additional hashtag without the # symbol (e.g. Programmatic, AdTech, OpenStandards, MediaBuying)"
}

Return ONLY the JSON, no markdown formatting.`;

  const prompt = `Article title: ${article.title}
Summary: ${article.summary}
Addie's notes: ${article.addie_notes || 'None'}
URL: ${article.source_url}`;

  try {
    const response = await complete({
      system,
      prompt,
      model: 'primary',
      maxTokens: 2000,
      operationName: 'social-post-ideas',
    });

    const parsed = JSON.parse(response.text);

    // Validate that we got usable content
    if (!parsed.linkedin_a && !parsed.linkedin_b) {
      logger.warn({ articleId: article.id, parsed }, 'LLM returned no usable social post content');
      return null;
    }

    if (parsed.twitter && parsed.twitter.length > 280) {
      logger.warn({ articleId: article.id, length: parsed.twitter.length }, 'Twitter post exceeds 280 chars');
    }

    return {
      angle: parsed.angle || '',
      linkedin_a: parsed.linkedin_a || '',
      linkedin_b: parsed.linkedin_b || '',
      twitter: parsed.twitter || '',
      topical_hashtag: parsed.topical_hashtag || 'AdTech',
    };
  } catch (error) {
    logger.error({ error, articleId: article.id }, 'Failed to generate social posts');
    return null;
  }
}

/**
 * Post social post ideas to the #social-post-ideas Slack channel.
 */
async function postToChannel(article: SocialPostArticle, ideas: SocialPostIdeas): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text' as const,
        text: article.title.substring(0, 150),
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Angle:* ${ideas.angle}`,
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*LinkedIn option A*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateForSlackBlock('```' + ideas.linkedin_a + '```'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*LinkedIn option B*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateForSlackBlock('```' + ideas.linkedin_b + '```'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*X/Twitter*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + ideas.twitter + '```',
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<${article.source_url}|Source article> · #AdCP #AgenticAdvertising #${ideas.topical_hashtag} · Make it yours -- change the opening, add your take, or disagree with a point.`,
        },
      ],
    },
  ];

  try {
    const result = await sendChannelMessage(SOCIAL_POST_IDEAS_CHANNEL!, {
      text: `Social post idea: ${article.title}`,
      blocks,
    });
    return result.ok === true;
  } catch (error) {
    logger.error({ error }, 'Failed to post social post ideas to Slack');
    return false;
  }
}
