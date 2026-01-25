/**
 * SI Retriever Service
 *
 * RAG-style retrieval of relevant SI agents based on message content.
 * Runs in parallel with routing to provide context for Sonnet without
 * requiring explicit tool calls.
 */

import { siDb } from "../../db/si-db.js";
import { logger } from "../../logger.js";

/**
 * Retrieved SI agent with relevance scoring
 */
export interface RetrievedSIAgent {
  slug: string;
  display_name: string;
  tagline: string | null;
  description: string | null;
  offerings: string[];
  brand_color: string | null;
  relevance_score: number;
}

/**
 * Result of SI agent retrieval
 */
export interface SIRetrievalResult {
  agents: RetrievedSIAgent[];
  retrieval_time_ms: number;
}

/**
 * Stop words to filter out during keyword extraction
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
  "from", "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "and", "but", "or", "if",
  "because", "until", "while", "about", "against", "this", "that", "these",
  "those", "am", "i", "me", "my", "you", "your", "we", "our", "they",
  "their", "what", "which", "who", "whom", "it", "its", "he", "she", "him",
  "her", "help", "want", "looking", "find", "tell", "talk", "connect",
  "know", "learn", "understand", "get", "make", "see", "think", "like",
]);

/**
 * Domain-specific keyword expansions for better matching
 */
const KEYWORD_EXPANSIONS: Record<string, string[]> = {
  "carbon": ["sustainability", "green", "emissions", "decarbonize", "environment"],
  "sustainability": ["carbon", "green", "emissions", "environment", "scope3"],
  "identity": ["id", "authentication", "rampid", "uid2", "cookie", "cookieless"],
  "programmatic": ["rtb", "bidding", "dsp", "ssp", "auction", "impression"],
  "ctv": ["connected tv", "streaming", "ott", "video"],
  "measurement": ["attribution", "analytics", "reporting", "metrics"],
  "data": ["audience", "targeting", "segments", "signals"],
  "privacy": ["consent", "gdpr", "ccpa", "tcf", "gpp"],
};

/**
 * Extract keywords from text for matching
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const keywords = new Set(words);

  // Add expansions for domain-specific terms
  for (const word of words) {
    const expansions = KEYWORD_EXPANSIONS[word];
    if (expansions) {
      for (const expansion of expansions) {
        keywords.add(expansion);
      }
    }
  }

  return keywords;
}

/**
 * Score how relevant a member is to the given keywords
 */
function scoreRelevance(
  member: {
    display_name: string;
    tagline: string | null;
    description: string | null;
    offerings: string[];
  },
  keywords: Set<string>
): number {
  let score = 0;

  // Check display name (high weight - exact match is very relevant)
  const nameLower = member.display_name.toLowerCase();
  for (const keyword of keywords) {
    if (nameLower.includes(keyword)) {
      score += 10;
    }
  }

  // Check tagline (medium-high weight)
  if (member.tagline) {
    const taglineLower = member.tagline.toLowerCase();
    for (const keyword of keywords) {
      if (taglineLower.includes(keyword)) {
        score += 5;
      }
    }
  }

  // Check offerings (high weight - these are expertise areas)
  for (const offering of member.offerings || []) {
    const offeringLower = offering.toLowerCase();
    for (const keyword of keywords) {
      if (offeringLower.includes(keyword)) {
        score += 7;
      }
    }
  }

  // Check description (lower weight - more generic)
  if (member.description) {
    const descLower = member.description.toLowerCase();
    for (const keyword of keywords) {
      if (descLower.includes(keyword)) {
        score += 2;
      }
    }
  }

  return score;
}

/**
 * Retrieve SI agents relevant to the given message
 *
 * @param message - The user's message
 * @param conversationContext - Optional conversation context for better matching
 * @param limit - Maximum number of agents to return (default 3)
 * @returns Relevant SI agents ranked by relevance score
 */
export async function retrieveRelevantSIAgents(
  message: string,
  conversationContext?: string,
  limit: number = 3
): Promise<SIRetrievalResult> {
  const startTime = Date.now();

  try {
    // Get all SI-enabled members
    const members = await siDb.getSiEnabledMembers();

    if (members.length === 0) {
      return {
        agents: [],
        retrieval_time_ms: Date.now() - startTime,
      };
    }

    // Extract keywords from message (and context if provided)
    const combinedText = conversationContext
      ? `${message} ${conversationContext}`
      : message;
    const keywords = extractKeywords(combinedText);

    // Score each member
    const scoredMembers = members.map((member) => ({
      slug: member.slug,
      display_name: member.display_name,
      tagline: member.tagline,
      description: member.description,
      offerings: member.offerings || [],
      brand_color: member.brand_color,
      relevance_score: scoreRelevance(
        {
          display_name: member.display_name,
          tagline: member.tagline,
          description: member.description,
          offerings: member.offerings || [],
        },
        keywords
      ),
    }));

    // Filter to only those with some relevance, sort by score, take top N
    const relevantAgents = scoredMembers
      .filter((m) => m.relevance_score > 0)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, limit);

    const retrievalTimeMs = Date.now() - startTime;

    logger.debug(
      {
        messagePreview: message.substring(0, 100),
        keywordCount: keywords.size,
        totalMembers: members.length,
        relevantCount: relevantAgents.length,
        retrievalTimeMs,
        topAgents: relevantAgents.map((a) => ({
          name: a.display_name,
          score: a.relevance_score,
        })),
      },
      "SI Retriever: Retrieved relevant agents"
    );

    return {
      agents: relevantAgents,
      retrieval_time_ms: retrievalTimeMs,
    };
  } catch (error) {
    logger.error({ error }, "SI Retriever: Failed to retrieve agents");
    return {
      agents: [],
      retrieval_time_ms: Date.now() - startTime,
    };
  }
}

/**
 * Format retrieved SI agents as context for Sonnet
 */
export function formatSIAgentsContext(agents: RetrievedSIAgent[]): string {
  if (agents.length === 0) return "";

  const agentList = agents
    .map((a) => {
      const offerings =
        a.offerings.length > 0
          ? `\n  Expertise: ${a.offerings.slice(0, 4).join(", ")}`
          : "";
      return `- **${a.display_name}**: ${a.tagline || "Available for conversation"}${offerings}`;
    })
    .join("\n");

  return `## Brands Available for Direct Conversation
The following brands have SI agents and may be relevant to this conversation:
${agentList}

If the user's intent aligns with these brands, offer to connect them directly using connect_to_si_agent(brand_name). You don't need to call list_si_agents first - these are already verified as available.`;
}

/**
 * SI Retriever class for stateful usage
 */
export class SIRetriever {
  /**
   * Retrieve relevant SI agents for a message
   */
  async retrieve(
    message: string,
    conversationContext?: string,
    limit?: number
  ): Promise<SIRetrievalResult> {
    return retrieveRelevantSIAgents(message, conversationContext, limit);
  }

  /**
   * Format agents as context string
   */
  formatContext(agents: RetrievedSIAgent[]): string {
    return formatSIAgentsContext(agents);
  }
}

// Default instance
export const siRetriever = new SIRetriever();
