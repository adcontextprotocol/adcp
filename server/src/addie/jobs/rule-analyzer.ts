/**
 * Addie Rule Analyzer
 *
 * Uses Claude to analyze interactions and suggest rule improvements.
 * Can be run on a schedule or triggered manually.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import {
  AddieDatabase,
  type AddieRule,
  type AddieRuleSuggestionInput,
  type AddieInteractionWithRating,
  type AnalysisType,
} from '../../db/addie-db.js';
import { randomUUID } from 'crypto';

const logger = createLogger('addie-rule-analyzer');

interface AnalysisResult {
  suggestions: AddieRuleSuggestionInput[];
  patterns: Record<string, unknown>;
  summary: string;
  tokensUsed: number;
}

interface ClaudeSuggestion {
  type: 'new_rule' | 'modify_rule' | 'disable_rule';
  target_rule_id?: number;
  rule_type?: string;
  name?: string;
  content: string;
  reasoning: string;
  confidence: number;
  expected_impact: string;
  supporting_interaction_ids: string[];
  pattern: string;
}

interface ClaudeAnalysisResponse {
  patterns: Array<{
    name: string;
    description: string;
    frequency: number;
    sentiment: 'positive' | 'negative' | 'neutral';
    example_interaction_ids: string[];
  }>;
  suggestions: ClaudeSuggestion[];
  summary: string;
}

/**
 * Analyze interactions and generate rule suggestions
 */
export async function analyzeInteractions(options: {
  db: AddieDatabase;
  anthropicApiKey: string;
  analysisType?: AnalysisType;
  days?: number;
  focusOnNegative?: boolean;
  maxInteractions?: number;
}): Promise<AnalysisResult> {
  const {
    db,
    anthropicApiKey,
    analysisType = 'manual',
    days = 7,
    focusOnNegative = false,
    maxInteractions = 100,
  } = options;

  // Start analysis run
  const analysisRun = await db.startAnalysisRun(analysisType);
  const batchId = randomUUID();

  try {
    // Get interactions to analyze
    const interactions = await db.getInteractionsForAnalysis({
      days,
      maxRating: focusOnNegative ? 3 : undefined,
      limit: maxInteractions,
    });

    if (interactions.length === 0) {
      await db.completeAnalysisRun(analysisRun.id, {
        interactions_analyzed: 0,
        suggestions_generated: 0,
        summary: 'No interactions found in the specified time range.',
      });

      return {
        suggestions: [],
        patterns: {},
        summary: 'No interactions found to analyze.',
        tokensUsed: 0,
      };
    }

    // Get current rules
    const rules = await db.getActiveRules();

    // Build analysis prompt
    const analysisPrompt = buildAnalysisPrompt(interactions, rules);

    // Call Claude for analysis
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `You are an expert at analyzing AI agent interactions and improving agent behavior through rule refinement.

Your task is to analyze a set of interactions between Addie (an AI assistant) and users, then suggest improvements to Addie's operating rules.

Focus on:
1. Patterns in user questions and Addie's responses
2. Cases where users seemed unsatisfied (low ratings, negative sentiment)
3. Opportunities to make Addie more helpful, accurate, or personable
4. Rules that may be too restrictive or too permissive
5. Missing capabilities or knowledge gaps

Output your analysis as JSON matching the specified schema.`,
      messages: [
        {
          role: 'user',
          content: analysisPrompt,
        },
      ],
    });

    // Parse Claude's response
    const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

    let analysis: ClaudeAnalysisResponse;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                        responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      analysis = JSON.parse(jsonStr);
    } catch (parseError) {
      logger.error({ error: parseError, response: responseText }, 'Failed to parse Claude analysis response');
      throw new Error('Failed to parse analysis response from Claude');
    }

    // Convert Claude suggestions to database format
    const suggestions: AddieRuleSuggestionInput[] = analysis.suggestions.map(s => ({
      suggestion_type: s.type,
      target_rule_id: s.target_rule_id,
      suggested_name: s.name,
      suggested_content: s.content,
      suggested_rule_type: s.rule_type as AddieRuleSuggestionInput['suggested_rule_type'],
      reasoning: s.reasoning,
      confidence: s.confidence,
      expected_impact: s.expected_impact,
      supporting_interactions: s.supporting_interaction_ids,
      pattern_summary: s.pattern,
      analysis_batch_id: batchId,
    }));

    // Save suggestions to database
    for (const suggestion of suggestions) {
      await db.createSuggestion(suggestion);
    }

    // Build patterns object
    const patterns: Record<string, unknown> = {
      identified: analysis.patterns,
      total_patterns: analysis.patterns.length,
      negative_patterns: analysis.patterns.filter(p => p.sentiment === 'negative').length,
    };

    // Complete analysis run
    await db.completeAnalysisRun(analysisRun.id, {
      interactions_analyzed: interactions.length,
      suggestions_generated: suggestions.length,
      patterns_found: patterns,
      summary: analysis.summary,
      model_used: 'claude-sonnet-4-20250514',
      tokens_used: tokensUsed,
    });

    logger.info({
      analysisId: analysisRun.id,
      interactionsAnalyzed: interactions.length,
      suggestionsGenerated: suggestions.length,
      patternsFound: analysis.patterns.length,
    }, 'Rule analysis completed');

    return {
      suggestions,
      patterns,
      summary: analysis.summary,
      tokensUsed,
    };
  } catch (error) {
    await db.failAnalysisRun(analysisRun.id, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Build the analysis prompt with interaction data and rules
 */
function buildAnalysisPrompt(
  interactions: AddieInteractionWithRating[],
  rules: AddieRule[]
): string {
  // Format interactions for analysis
  const interactionSummaries = interactions.map(i => ({
    id: i.id,
    user_input: i.input_text.substring(0, 500),
    addie_response: i.output_text.substring(0, 1000),
    tools_used: i.tools_used,
    rating: i.rating,
    outcome: i.outcome,
    user_sentiment: i.user_sentiment,
    latency_ms: i.latency_ms,
  }));

  // Format current rules
  const ruleSummaries = rules.map(r => ({
    id: r.id,
    type: r.rule_type,
    name: r.name,
    content: r.content.substring(0, 500),
    interactions_count: r.interactions_count,
    avg_rating: r.avg_rating,
    positive_ratings: r.positive_ratings,
    negative_ratings: r.negative_ratings,
  }));

  return `Analyze the following interactions and current rules, then provide suggestions for improvement.

## Current Rules

${JSON.stringify(ruleSummaries, null, 2)}

## Recent Interactions (${interactions.length} total)

${JSON.stringify(interactionSummaries, null, 2)}

## Analysis Instructions

1. Identify patterns in the interactions - what questions are common, what responses work well, what causes issues
2. Look for rules that may need modification based on interaction outcomes
3. Suggest new rules for gaps in current behavior
4. Consider disabling rules that may be causing problems
5. Be conservative - only suggest changes with clear evidence

## Output Schema

Respond with JSON matching this schema:

\`\`\`json
{
  "patterns": [
    {
      "name": "Pattern name",
      "description": "What this pattern represents",
      "frequency": 0.25,
      "sentiment": "positive" | "negative" | "neutral",
      "example_interaction_ids": ["id1", "id2"]
    }
  ],
  "suggestions": [
    {
      "type": "new_rule" | "modify_rule" | "disable_rule",
      "target_rule_id": null,
      "rule_type": "system_prompt" | "behavior" | "knowledge" | "constraint" | "response_style",
      "name": "Rule name (for new rules)",
      "content": "The full rule content",
      "reasoning": "Why this change would help",
      "confidence": 0.8,
      "expected_impact": "What improvement we expect",
      "supporting_interaction_ids": ["id1", "id2"],
      "pattern": "Which pattern this addresses"
    }
  ],
  "summary": "Overall summary of the analysis findings"
}
\`\`\`

Focus on actionable, evidence-based suggestions. Only suggest changes where you have reasonable confidence they will improve Addie's performance.`;
}

/**
 * Preview how a rule change would affect historical interactions
 */
export async function previewRuleChange(options: {
  db: AddieDatabase;
  anthropicApiKey: string;
  proposedRules: AddieRule[];
  sampleSize?: number;
}): Promise<{
  predictions: Array<{
    interaction_id: string;
    original_response: string;
    predicted_response: string;
    expected_improvement: string;
    confidence: number;
  }>;
  overall_assessment: string;
}> {
  const { db, anthropicApiKey, proposedRules, sampleSize = 10 } = options;

  // Get sample of recent interactions
  const interactions = await db.getInteractionsForAnalysis({
    days: 14,
    limit: sampleSize,
  });

  if (interactions.length === 0) {
    return {
      predictions: [],
      overall_assessment: 'No interactions available for preview.',
    };
  }

  // Build system prompt from proposed rules
  const proposedPrompt = buildSystemPromptFromRules(proposedRules);

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  // For each interaction, predict how the new rules would change the response
  const predictions = [];

  for (const interaction of interactions.slice(0, 5)) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `You are evaluating how a change in operating rules would affect an AI assistant's response.

Given:
1. The user's original input
2. The assistant's original response
3. The proposed new operating rules

Predict how the response would differ under the new rules. Be specific about improvements or potential issues.`,
      messages: [
        {
          role: 'user',
          content: `## Proposed Rules

${proposedPrompt}

## Original Interaction

User: ${interaction.input_text}

Original Response: ${interaction.output_text}

## Task

Predict how the response would change under these rules. Output JSON:

\`\`\`json
{
  "predicted_response": "What the new response would be (brief summary)",
  "expected_improvement": "How this is better or worse",
  "confidence": 0.8
}
\`\`\``,
        },
      ],
    });

    const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                        responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      const prediction = JSON.parse(jsonStr);

      predictions.push({
        interaction_id: interaction.id,
        original_response: interaction.output_text.substring(0, 200),
        predicted_response: prediction.predicted_response,
        expected_improvement: prediction.expected_improvement,
        confidence: prediction.confidence,
      });
    } catch {
      logger.warn({ interactionId: interaction.id }, 'Failed to parse prediction');
    }
  }

  // Generate overall assessment
  const assessmentResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Based on these predictions of how rule changes would affect responses, provide a brief overall assessment:

${JSON.stringify(predictions, null, 2)}

In 2-3 sentences, summarize whether these rule changes seem beneficial and any risks.`,
      },
    ],
  });

  const overallAssessment = assessmentResponse.content[0].type === 'text'
    ? assessmentResponse.content[0].text
    : 'Unable to generate assessment.';

  return {
    predictions,
    overall_assessment: overallAssessment,
  };
}

/**
 * Build system prompt from rules (helper function)
 */
function buildSystemPromptFromRules(rules: AddieRule[]): string {
  const sections: Record<string, string[]> = {
    system_prompt: [],
    behavior: [],
    knowledge: [],
    constraint: [],
    response_style: [],
  };

  for (const rule of rules) {
    sections[rule.rule_type].push(`## ${rule.name}\n${rule.content}`);
  }

  const parts: string[] = [];

  if (sections.system_prompt.length > 0) {
    parts.push('# Core Identity\n\n' + sections.system_prompt.join('\n\n'));
  }

  if (sections.behavior.length > 0) {
    parts.push('# Behaviors\n\n' + sections.behavior.join('\n\n'));
  }

  if (sections.knowledge.length > 0) {
    parts.push('# Knowledge\n\n' + sections.knowledge.join('\n\n'));
  }

  if (sections.constraint.length > 0) {
    parts.push('# Constraints\n\n' + sections.constraint.join('\n\n'));
  }

  if (sections.response_style.length > 0) {
    parts.push('# Response Style\n\n' + sections.response_style.join('\n\n'));
  }

  return parts.join('\n\n---\n\n');
}
