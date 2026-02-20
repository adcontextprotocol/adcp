/**
 * Insight Extractor Service
 *
 * Analyzes conversation messages to extract structured insights about members.
 * Works across all inbound channels (Slack DMs, @mentions, web chat, A2A).
 *
 * Flow:
 * 1. After each conversation message, handler calls extractInsights()
 * 2. Fetches active insight types and goals from database
 * 3. Uses Claude to analyze the message for relevant insights
 * 4. Stores extracted insights with source tracking
 */

import { logger } from '../../logger.js';
import {
  InsightsDatabase,
  type MemberInsightType,
  type InsightGoal,
  type InsightConfidence,
} from '../../db/insights-db.js';
import { invalidateInsightsCache } from '../insights-cache.js';
import { trackApiCall, ApiPurpose } from './api-tracker.js';
import { isLLMConfigured, complete } from '../../utils/llm.js';
import { OrgKnowledgeDatabase } from '../../db/org-knowledge-db.js';

const insightsDb = new InsightsDatabase();
const orgKnowledgeDb = new OrgKnowledgeDatabase();

/**
 * Extracted insight from Claude analysis
 */
interface ExtractedInsight {
  type_name: string;
  value: string;
  confidence: InsightConfidence;
  extracted_from: string;
}

/**
 * Goal response detected in conversation
 */
interface GoalResponse {
  goal_id: number;
  response_value: string;
  extracted_from: string;
}

/**
 * Result of insight extraction
 */
export interface ExtractionResult {
  insights: ExtractedInsight[];
  goal_responses: GoalResponse[];
  skipped: boolean;
  skip_reason?: string;
}

/**
 * Context for insight extraction
 */
export interface ExtractionContext {
  slackUserId: string;
  workosUserId?: string;
  threadId?: string;
  messageId?: string;
  isMapped: boolean;
}

/**
 * Build the prompt for Claude to extract insights
 */
function buildExtractionPrompt(
  message: string,
  insightTypes: MemberInsightType[],
  activeGoals: InsightGoal[]
): string {
  const typesDescription = insightTypes
    .map(t => {
      const examples = t.example_values?.length
        ? ` (examples: ${t.example_values.slice(0, 3).join(', ')})`
        : '';
      return `- ${t.name}: ${t.description || 'No description'}${examples}`;
    })
    .join('\n');

  const goalsDescription = activeGoals.length > 0
    ? activeGoals.map(g => `- Goal ${g.id}: ${g.question}`).join('\n')
    : 'No active goals';

  return `Analyze this conversation message for insights about the user. Extract any information that matches our insight taxonomy.

**Insight Types to Look For:**
${typesDescription}

**Active Goals (questions we want to learn about):**
${goalsDescription}

**Message to Analyze:**
${message}

**Instructions:**
1. Look for explicit or implicit information about the user that matches our insight types
2. Only extract insights you're confident about - don't guess or make assumptions
3. For each insight, include the exact phrase or sentence that reveals this information
4. Check if the user answered any of our active goal questions
5. Confidence levels:
   - "high": User explicitly stated this information
   - "medium": Strong implication from context
   - "low": Weak implication, might need confirmation

Return a JSON object with this structure:
{
  "insights": [
    {
      "type_name": "role",
      "value": "Publisher",
      "confidence": "high",
      "extracted_from": "I work at a publisher..."
    }
  ],
  "goal_responses": [
    {
      "goal_id": 1,
      "response_value": "Their answer to the goal question",
      "extracted_from": "The exact text they said"
    }
  ]
}

If no insights or goal responses are found, return:
{
  "insights": [],
  "goal_responses": []
}

Return ONLY valid JSON, no markdown formatting or explanation.`;
}

/**
 * Check if a message is worth analyzing for insights
 * Skip very short messages, commands, etc.
 * Note: Keep threshold low to capture short responses like "Just exploring" (14 chars)
 */
function shouldAnalyzeMessage(message: string): { should: boolean; reason?: string } {
  // Skip very short messages (lowered from 20 to capture short responses to "what brings you here?")
  if (message.length < 10) {
    return { should: false, reason: 'Message too short' };
  }

  // Skip messages that are just simple greetings or acknowledgments (exact match only)
  const simplePatterns = [
    /^(help|hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|bye)[\s!?.]*$/i,
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(message.trim())) {
      return { should: false, reason: 'Message is just a greeting/acknowledgment' };
    }
  }

  return { should: true };
}

/**
 * Extract insights from a conversation message
 *
 * @param message - The user's message to analyze
 * @param context - Context about the user and conversation
 * @returns Extraction result with insights and goal responses
 */
export async function extractInsights(
  message: string,
  context: ExtractionContext
): Promise<ExtractionResult> {
  // Check if message is worth analyzing
  const shouldAnalyze = shouldAnalyzeMessage(message);
  if (!shouldAnalyze.should) {
    return {
      insights: [],
      goal_responses: [],
      skipped: true,
      skip_reason: shouldAnalyze.reason,
    };
  }

  if (!isLLMConfigured()) {
    logger.warn('Insight extractor: No API key configured');
    return {
      insights: [],
      goal_responses: [],
      skipped: true,
      skip_reason: 'No API key configured',
    };
  }

  try {
    // Fetch active insight types and goals
    const [insightTypes, activeGoals] = await Promise.all([
      insightsDb.listInsightTypes(true), // activeOnly = true
      insightsDb.getActiveGoalsForUser(context.isMapped),
    ]);

    // If no insight types defined, skip extraction
    if (insightTypes.length === 0) {
      return {
        insights: [],
        goal_responses: [],
        skipped: true,
        skip_reason: 'No active insight types defined',
      };
    }

    // Build prompt and call Claude
    const prompt = buildExtractionPrompt(message, insightTypes, activeGoals);

    const result = await complete({
      prompt,
      maxTokens: 1000,
      model: 'fast',
      operationName: 'insight-extraction',
    });

    // Track for performance metrics (fire-and-forget, errors handled internally)
    void trackApiCall({
      model: result.model,
      purpose: ApiPurpose.INSIGHT_EXTRACTION,
      tokens_input: result.inputTokens,
      tokens_output: result.outputTokens,
      latency_ms: result.latencyMs,
      thread_id: context.threadId,
    });

    // Parse response
    const responseText = result.text;

    let parsed: { insights: ExtractedInsight[]; goal_responses: GoalResponse[] };
    try {
      parsed = JSON.parse(responseText);
    } catch {
      logger.warn({ responseText }, 'Insight extractor: Failed to parse response as JSON');
      return {
        insights: [],
        goal_responses: [],
        skipped: true,
        skip_reason: 'Failed to parse extraction response',
      };
    }

    // Store extracted insights
    const storedInsights: ExtractedInsight[] = [];
    for (const insight of parsed.insights || []) {
      // Find the insight type ID
      const insightType = insightTypes.find(t => t.name === insight.type_name);
      if (!insightType) {
        logger.warn({ typeName: insight.type_name }, 'Insight extractor: Unknown insight type');
        continue;
      }

      try {
        await insightsDb.addInsight({
          slack_user_id: context.slackUserId,
          workos_user_id: context.workosUserId,
          insight_type_id: insightType.id,
          value: insight.value,
          confidence: insight.confidence,
          source_type: 'conversation',
          source_thread_id: context.threadId,
          source_message_id: context.messageId,
          extracted_from: insight.extracted_from,
        });
        storedInsights.push(insight);
        logger.debug(
          { slackUserId: context.slackUserId, type: insight.type_name, value: insight.value },
          'Insight extractor: Stored insight'
        );
      } catch (error) {
        logger.error({ error, insight }, 'Insight extractor: Failed to store insight');
      }
    }

    // Process goal responses
    const storedGoalResponses: GoalResponse[] = [];
    for (const goalResponse of parsed.goal_responses || []) {
      // Find the goal
      const goal = activeGoals.find(g => g.id === goalResponse.goal_id);
      if (!goal) {
        logger.warn({ goalId: goalResponse.goal_id }, 'Insight extractor: Unknown goal ID');
        continue;
      }

      try {
        // If goal has an associated insight type, store as insight
        if (goal.insight_type_id) {
          await insightsDb.addInsight({
            slack_user_id: context.slackUserId,
            workos_user_id: context.workosUserId,
            insight_type_id: goal.insight_type_id,
            value: goalResponse.response_value,
            confidence: 'high', // Direct answer to a goal question
            source_type: 'conversation',
            source_thread_id: context.threadId,
            source_message_id: context.messageId,
            extracted_from: goalResponse.extracted_from,
          });
        }

        storedGoalResponses.push(goalResponse);

        logger.debug(
          { slackUserId: context.slackUserId, goalId: goal.id },
          'Insight extractor: Recorded goal response'
        );
      } catch (error) {
        logger.error({ error, goalResponse }, 'Insight extractor: Failed to process goal response');
      }
    }

    // Invalidate insights cache if we stored any new insights
    if (storedInsights.length > 0 || storedGoalResponses.length > 0) {
      invalidateInsightsCache(context.slackUserId);
    }

    // Write org-level insights to org_knowledge for provenance tracking
    if ((storedInsights.length > 0) && context.workosUserId) {
      try {
        const pool = (await import('../../db/client.js')).getPool();
        const orgResult = await pool.query(
          `SELECT workos_organization_id FROM organization_memberships WHERE workos_user_id = $1 LIMIT 1`,
          [context.workosUserId]
        );
        const orgId = orgResult.rows[0]?.workos_organization_id;
        if (orgId) {
          const orgLevelTypes = ['building', 'company_focus', 'interest', 'aao_goals', 'focus_area'];
          for (const insight of storedInsights) {
            if (orgLevelTypes.includes(insight.type_name)) {
              orgKnowledgeDb.setKnowledge({
                workos_organization_id: orgId,
                attribute: insight.type_name,
                value: insight.value,
                source: 'addie_inferred',
                confidence: insight.confidence === 'high' ? 'high' : insight.confidence === 'medium' ? 'medium' : 'low',
                set_by_user_id: context.workosUserId,
                set_by_description: 'Addie conversation insight extraction',
                source_reference: context.threadId,
              }).catch(err => {
                logger.warn({ err, orgId, attribute: insight.type_name }, 'Failed to write insight to org_knowledge');
              });
            }
          }
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to look up org for insight provenance');
      }
    }

    logger.info(
      {
        slackUserId: context.slackUserId,
        insightsFound: storedInsights.length,
        goalResponsesFound: storedGoalResponses.length,
      },
      'Insight extractor: Extraction complete'
    );

    return {
      insights: storedInsights,
      goal_responses: storedGoalResponses,
      skipped: false,
    };
  } catch (error) {
    logger.error({ error }, 'Insight extractor: Error during extraction');
    return {
      insights: [],
      goal_responses: [],
      skipped: true,
      skip_reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get active insight goals for injecting into Addie's system prompt
 * Returns goals formatted for inclusion in the prompt
 */
export async function getGoalsForSystemPrompt(isMapped: boolean): Promise<string | null> {
  try {
    const goals = await insightsDb.getActiveGoalsForUser(isMapped);
    if (goals.length === 0) {
      return null;
    }

    const goalsText = goals
      .sort((a, b) => b.priority - a.priority) // Higher priority first
      .slice(0, 5) // Limit to top 5 goals
      .map(g => `- ${g.question}`)
      .join('\n');

    return `
**Member Insight Goals**
When appropriate during conversation, try to naturally learn about these topics:
${goalsText}

Don't force these questions - only ask if it feels natural in the conversation context.
When the user shares relevant information, acknowledge it naturally without being obvious about data collection.`;
  } catch (error) {
    logger.error({ error }, 'Insight extractor: Failed to get goals for system prompt');
    return null;
  }
}

/**
 * Check if a user has pending outreach that was responded to
 * Used to mark outreach as successful when user replies
 */
export async function checkAndMarkOutreachResponse(
  slackUserId: string,
  hadInsights: boolean
): Promise<void> {
  try {
    const pendingOutreach = await insightsDb.getPendingOutreach(slackUserId);
    if (pendingOutreach) {
      await insightsDb.markOutreachResponded(pendingOutreach.id, hadInsights);
      logger.info(
        { outreachId: pendingOutreach.id, slackUserId, hadInsights },
        'Insight extractor: Marked outreach as responded'
      );
    }
  } catch (error) {
    logger.error({ error, slackUserId }, 'Insight extractor: Failed to check outreach response');
  }
}
