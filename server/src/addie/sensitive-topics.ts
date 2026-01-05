/**
 * Sensitive Topic Detection for Addie
 *
 * Detects journalist-bait questions and sensitive topics that should
 * be deflected to human contacts rather than answered by AI.
 */

import { logger } from '../logger.js';
import { InsightsDatabase, type SensitiveTopicResult, type KnownMediaContact } from '../db/insights-db.js';

const insightsDb = new InsightsDatabase();

export interface SensitiveTopicCheck {
  shouldDeflect: boolean;
  isKnownMedia: boolean;
  mediaContact: KnownMediaContact | null;
  topicResult: SensitiveTopicResult;
  deflectResponse: string | null;
  flaggedConversationId: number | null;
}

/**
 * Check a message for sensitive topics and determine if it should be deflected
 * Also checks if the user is a known media contact
 */
export async function checkForSensitiveTopics(
  messageText: string,
  slackUserId: string,
  slackChannelId?: string
): Promise<SensitiveTopicCheck> {
  try {
    // Check in parallel: is this a sensitive topic and is this a media contact
    const [topicResult, mediaContact] = await Promise.all([
      insightsDb.checkSensitiveTopic(messageText),
      insightsDb.isKnownMediaContact(slackUserId),
    ]);

    // Determine if we should deflect
    // - Always deflect for high severity topics
    // - Deflect for medium severity if known media contact
    // - Flag but don't deflect for low severity
    const isKnownMedia = mediaContact !== null;
    let shouldDeflect = false;

    if (topicResult.isSensitive) {
      if (topicResult.severity === 'high') {
        shouldDeflect = true;
      } else if (topicResult.severity === 'medium' && isKnownMedia) {
        shouldDeflect = true;
      } else if (topicResult.severity === 'medium' && mediaContact?.handlingLevel === 'careful') {
        shouldDeflect = true;
      }
    }

    // For executive_only handling level, always deflect any question
    if (mediaContact?.handlingLevel === 'executive_only') {
      shouldDeflect = true;
    }

    // Build the deflection response
    let deflectResponse: string | null = null;
    if (shouldDeflect) {
      deflectResponse = topicResult.deflectResponse || getDefaultDeflection(topicResult.category);
    }

    // Flag the conversation if it hit a sensitive topic (regardless of deflection)
    let flaggedConversationId: number | null = null;
    if (topicResult.isSensitive || isKnownMedia) {
      try {
        const flagged = await insightsDb.flagConversation({
          slackUserId,
          slackChannelId,
          messageText,
          matchedPatternId: topicResult.patternId ?? undefined,
          matchedCategory: topicResult.category ?? undefined,
          severity: topicResult.severity ?? undefined,
          responseGiven: deflectResponse ?? undefined,
          wasDeflected: shouldDeflect,
        });
        flaggedConversationId = flagged.id;

        logger.info({
          flaggedId: flaggedConversationId,
          slackUserId,
          category: topicResult.category,
          severity: topicResult.severity,
          isKnownMedia,
          shouldDeflect,
        }, 'Addie: Flagged sensitive conversation');
      } catch (flagError) {
        logger.error({ error: flagError }, 'Addie: Failed to flag conversation');
      }
    }

    return {
      shouldDeflect,
      isKnownMedia,
      mediaContact,
      topicResult,
      deflectResponse,
      flaggedConversationId,
    };
  } catch (error) {
    logger.error({ error }, 'Addie: Error checking sensitive topics');
    // On error, don't block - just return safe defaults
    return {
      shouldDeflect: false,
      isKnownMedia: false,
      mediaContact: null,
      topicResult: {
        isSensitive: false,
        patternId: null,
        category: null,
        severity: null,
        deflectResponse: null,
      },
      deflectResponse: null,
      flaggedConversationId: null,
    };
  }
}

/**
 * Get a default deflection response for a category
 */
function getDefaultDeflection(category: string | null): string {
  switch (category) {
    case 'vulnerable_populations':
      return "That's an important topic that deserves careful consideration. I'd recommend reaching out to our policy team for a thoughtful response.";
    case 'political':
      return "Questions about political topics require careful handling. I'd recommend reaching out to our communications team who can provide appropriate context.";
    case 'named_individual':
      return "For questions about specific individuals, I'd recommend reaching out to them directly or through official channels.";
    case 'organization_position':
      return "For official organizational positions, I'd recommend checking our public documentation or reaching out to our communications team.";
    case 'competitive':
      return "I focus on what AgenticAdvertising.org does rather than comparisons. Happy to explain our approach if you have specific questions!";
    case 'privacy_surveillance':
      return "Privacy and data ethics are important topics. Our technical documentation covers our approach, or I can connect you with our policy team for deeper discussion.";
    case 'ethical_concerns':
      return "That's a thoughtful question that deserves a nuanced response. I'd recommend reaching out to our policy team who can provide appropriate context.";
    case 'media_inquiry':
      return "Thanks for reaching out! For media inquiries, please contact our communications team who can best assist you.";
    default:
      return "That's a great question that deserves a thoughtful answer. Let me connect you with someone who can speak to this properly.";
  }
}

/**
 * Check if a message appears to be from someone asking for quotes/official statements
 * (Supplementary check beyond pattern matching)
 */
export function hasMediaIndicators(messageText: string): boolean {
  const lowerText = messageText.toLowerCase();
  const indicators = [
    'writing a story',
    'working on an article',
    'for a piece',
    'for publication',
    'can i quote',
    'on the record',
    'off the record',
    'background only',
    'official statement',
    'official position',
    'spokesperson',
    'press inquiry',
    'media inquiry',
  ];
  return indicators.some(indicator => lowerText.includes(indicator));
}
