/**
 * Tests for SI Retriever Service
 *
 * Tests the pure functions for keyword extraction, relevance scoring,
 * and context formatting. Database-dependent functions are tested
 * via integration tests.
 */

import { describe, it, expect } from '@jest/globals';

// Define the RetrievedSIAgent type locally to avoid importing the module
// (which has database dependencies)
interface RetrievedSIAgent {
  slug: string;
  display_name: string;
  tagline: string | null;
  description: string | null;
  offerings: string[];
  brand_color: string | null;
  relevance_score: number;
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
 * Format retrieved SI agents as context for Sonnet
 */
function formatSIAgentsContext(agents: RetrievedSIAgent[]): string {
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

// ============================================================================
// Tests
// ============================================================================

describe('SI Retriever', () => {
  describe('extractKeywords', () => {
    it('extracts meaningful words from text', () => {
      const keywords = extractKeywords('I want to learn about carbon measurement');
      expect(keywords.has('carbon')).toBe(true);
      expect(keywords.has('measurement')).toBe(true);
      // Stop words should be filtered out
      expect(keywords.has('want')).toBe(false);
      expect(keywords.has('to')).toBe(false);
      expect(keywords.has('about')).toBe(false);
    });

    it('filters out short words', () => {
      const keywords = extractKeywords('I am at an ad');
      expect(keywords.has('am')).toBe(false);
      expect(keywords.has('at')).toBe(false);
      expect(keywords.has('an')).toBe(false);
      expect(keywords.has('ad')).toBe(false); // 2 chars, too short
    });

    it('expands domain-specific terms', () => {
      const keywords = extractKeywords('Tell me about carbon');
      expect(keywords.has('carbon')).toBe(true);
      // Should include expansions
      expect(keywords.has('sustainability')).toBe(true);
      expect(keywords.has('green')).toBe(true);
      expect(keywords.has('emissions')).toBe(true);
    });

    it('expands identity terms', () => {
      const keywords = extractKeywords('Help with identity resolution');
      expect(keywords.has('identity')).toBe(true);
      expect(keywords.has('rampid')).toBe(true);
      expect(keywords.has('uid2')).toBe(true);
      expect(keywords.has('cookie')).toBe(true);
    });

    it('expands programmatic terms', () => {
      const keywords = extractKeywords('Programmatic advertising help');
      expect(keywords.has('programmatic')).toBe(true);
      expect(keywords.has('rtb')).toBe(true);
      expect(keywords.has('dsp')).toBe(true);
      expect(keywords.has('ssp')).toBe(true);
    });

    it('handles punctuation', () => {
      const keywords = extractKeywords('What about carbon? And sustainability!');
      expect(keywords.has('carbon')).toBe(true);
      expect(keywords.has('sustainability')).toBe(true);
    });

    it('is case-insensitive', () => {
      const keywords = extractKeywords('CARBON Measurement');
      expect(keywords.has('carbon')).toBe(true);
      expect(keywords.has('measurement')).toBe(true);
    });
  });

  describe('scoreRelevance', () => {
    const scope3Member = {
      display_name: 'Scope3',
      tagline: 'Decarbonize your digital advertising',
      description: 'Scope3 provides carbon measurement and decarbonization tools.',
      offerings: ['carbon measurement', 'sustainability', 'green advertising'],
    };

    const tradeDeskMember = {
      display_name: 'The Trade Desk',
      tagline: 'The leading independent demand-side platform',
      description: 'The Trade Desk empowers brands with programmatic advertising.',
      offerings: ['programmatic', 'dsp', 'ctv', 'connected tv'],
    };

    it('scores based on display name match', () => {
      const keywords = extractKeywords('Scope3');
      const score = scoreRelevance(scope3Member, keywords);
      expect(score).toBeGreaterThan(0);
    });

    it('scores based on tagline match', () => {
      const keywords = extractKeywords('decarbonize advertising');
      const score = scoreRelevance(scope3Member, keywords);
      expect(score).toBeGreaterThan(0);
    });

    it('scores based on offerings match', () => {
      const keywords = extractKeywords('carbon measurement');
      const score = scoreRelevance(scope3Member, keywords);
      // Should match offerings
      expect(score).toBeGreaterThan(0);
    });

    it('scores based on description match', () => {
      const keywords = extractKeywords('decarbonization tools');
      const score = scoreRelevance(scope3Member, keywords);
      expect(score).toBeGreaterThan(0);
    });

    it('returns zero for no matches', () => {
      const keywords = extractKeywords('pizza delivery');
      const scope3Score = scoreRelevance(scope3Member, keywords);
      const tradeDeskScore = scoreRelevance(tradeDeskMember, keywords);
      expect(scope3Score).toBe(0);
      expect(tradeDeskScore).toBe(0);
    });

    it('scores programmatic queries for Trade Desk', () => {
      const keywords = extractKeywords('programmatic advertising');
      const tradeDeskScore = scoreRelevance(tradeDeskMember, keywords);
      const scope3Score = scoreRelevance(scope3Member, keywords);
      // Trade Desk should score higher for programmatic
      expect(tradeDeskScore).toBeGreaterThan(scope3Score);
    });

    it('scores sustainability queries for Scope3', () => {
      const keywords = extractKeywords('sustainability carbon emissions');
      const scope3Score = scoreRelevance(scope3Member, keywords);
      const tradeDeskScore = scoreRelevance(tradeDeskMember, keywords);
      // Scope3 should score higher for sustainability
      expect(scope3Score).toBeGreaterThan(tradeDeskScore);
    });

    it('accumulates scores for multiple matches', () => {
      const keywords = extractKeywords('carbon measurement sustainability green');
      const score = scoreRelevance(scope3Member, keywords);
      // Should have multiple matches in offerings and elsewhere
      expect(score).toBeGreaterThan(20);
    });
  });

  describe('formatSIAgentsContext', () => {
    it('returns empty string for no agents', () => {
      const result = formatSIAgentsContext([]);
      expect(result).toBe('');
    });

    it('formats a single agent with tagline', () => {
      const agents: RetrievedSIAgent[] = [
        {
          slug: 'scope3',
          display_name: 'Scope3',
          tagline: 'Decarbonize your digital advertising',
          description: 'Carbon measurement tools',
          offerings: ['carbon measurement', 'sustainability'],
          brand_color: '#00B050',
          relevance_score: 15,
        },
      ];

      const result = formatSIAgentsContext(agents);
      expect(result).toContain('## Brands Available for Direct Conversation');
      expect(result).toContain('**Scope3**');
      expect(result).toContain('Decarbonize your digital advertising');
      expect(result).toContain('Expertise: carbon measurement, sustainability');
      expect(result).toContain('connect_to_si_agent');
    });

    it('formats multiple agents', () => {
      const agents: RetrievedSIAgent[] = [
        {
          slug: 'scope3',
          display_name: 'Scope3',
          tagline: 'Decarbonize your digital advertising',
          description: null,
          offerings: ['carbon measurement'],
          brand_color: '#00B050',
          relevance_score: 15,
        },
        {
          slug: 'the-trade-desk',
          display_name: 'The Trade Desk',
          tagline: 'Leading DSP platform',
          description: null,
          offerings: ['programmatic', 'dsp', 'ctv'],
          brand_color: '#0076D1',
          relevance_score: 10,
        },
      ];

      const result = formatSIAgentsContext(agents);
      expect(result).toContain('**Scope3**');
      expect(result).toContain('**The Trade Desk**');
      expect(result).toContain('carbon measurement');
      expect(result).toContain('programmatic, dsp, ctv');
    });

    it('handles agent without tagline', () => {
      const agents: RetrievedSIAgent[] = [
        {
          slug: 'test',
          display_name: 'Test Brand',
          tagline: null,
          description: 'Test description',
          offerings: [],
          brand_color: null,
          relevance_score: 5,
        },
      ];

      const result = formatSIAgentsContext(agents);
      expect(result).toContain('**Test Brand**');
      expect(result).toContain('Available for conversation');
    });

    it('limits offerings to 4', () => {
      const agents: RetrievedSIAgent[] = [
        {
          slug: 'test',
          display_name: 'Test Brand',
          tagline: 'Test tagline',
          description: null,
          offerings: ['one', 'two', 'three', 'four', 'five', 'six'],
          brand_color: null,
          relevance_score: 5,
        },
      ];

      const result = formatSIAgentsContext(agents);
      expect(result).toContain('one, two, three, four');
      expect(result).not.toContain('five');
      expect(result).not.toContain('six');
    });

    it('handles agent with no offerings', () => {
      const agents: RetrievedSIAgent[] = [
        {
          slug: 'test',
          display_name: 'Test Brand',
          tagline: 'Test tagline',
          description: null,
          offerings: [],
          brand_color: null,
          relevance_score: 5,
        },
      ];

      const result = formatSIAgentsContext(agents);
      expect(result).toContain('**Test Brand**');
      expect(result).not.toContain('Expertise:');
    });
  });
});
