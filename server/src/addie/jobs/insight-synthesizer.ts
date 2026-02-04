/**
 * Insight Synthesizer
 *
 * Takes tagged insight sources and synthesizes them into compact, coherent rules
 * for Addie's system prompt. Uses Claude to distill multiple sources into
 * focused knowledge rules.
 */

import { createLogger } from '../../logger.js';
import { complete } from '../../utils/llm.js';
import { ModelConfig } from '../../config/models.js';
import {
  AddieDatabase,
  type InsightSource,
  type ProposedRule,
  type SynthesisRun,
  type SynthesisPreviewResults,
  type SynthesisPreviewPrediction,
  type AddieRule,
  type RuleType,
} from '../../db/addie-db.js';
import {
  getOrCreateConfigVersion,
  invalidateConfigCache,
  type RuleSnapshot,
} from '../config-version.js';

const logger = createLogger('insight-synthesizer');

// Synthesized rules get priority between core identity rules (200) and behavior rules (150)
const SYNTHESIZED_RULE_PRIORITY = 175;

// ============== Types ==============

export interface SynthesisOptions {
  topic?: string;           // Synthesize specific topic, or all pending if undefined
  maxSources?: number;      // Limit sources per run (default: 50)
  previewSampleSize?: number; // Historical interactions to test against (default: 20)
  createdBy?: string;       // Who triggered the synthesis
}

export interface SynthesisResult {
  run: SynthesisRun;
  proposedRules: ProposedRule[];
  preview: SynthesisPreviewResults | null;
  gaps: string[];           // Topics that need more source material
}

interface ClaudeSynthesisResponse {
  rules: Array<{
    rule_type: RuleType;
    name: string;
    content: string;
    source_ids: number[];
    confidence: number;
  }>;
  gaps: string[];
}

// ============== Prompts ==============

const SYNTHESIS_SYSTEM_PROMPT = `You are distilling expert insights into concise operating rules for an AI assistant named Addie.

Addie is the AI assistant for AgenticAdvertising.org, helping the ad tech industry understand and adopt AdCP (Ad Context Protocol) and agentic advertising.

Your task:
1. Read the tagged source materials (conversations, articles, emails from experts)
2. Extract the core beliefs, frameworks, and perspectives
3. Synthesize into compact, coherent rules that Addie can reason with
4. DO NOT attribute - these become Addie's own beliefs, not "Ben says..." or "According to..."
5. Focus on actionable guidance and clear positions, not just facts

Rules should:
- Be 2-4 paragraphs max
- State clear positions (not wishy-washy)
- Include concrete examples where helpful
- Be written in second person ("You believe...", "When asked about X, explain...")

Output JSON matching this schema:
{
  "rules": [
    {
      "rule_type": "knowledge",
      "name": "Short descriptive name (e.g., 'AdCP Adoption Philosophy')",
      "content": "The synthesized rule content",
      "source_ids": [1, 3, 5],
      "confidence": 0.9
    }
  ],
  "gaps": [
    "Topics that need more source material before synthesis"
  ]
}

Keep rules COMPACT. Better to have 3 focused rules than 1 sprawling one.
Prefer fewer, higher-quality rules over many mediocre ones.`;

// ============== Main Functions ==============

/**
 * Synthesize pending insight sources into rules
 */
export async function synthesizeInsights(
  db: AddieDatabase,
  options: SynthesisOptions = {}
): Promise<SynthesisResult> {
  const {
    topic,
    maxSources = 50,
    previewSampleSize = 20,
    createdBy,
  } = options;

  const startTime = Date.now();

  // 1. Gather pending sources
  const sources = await db.getPendingInsightSources(topic, maxSources);

  if (sources.length === 0) {
    throw new Error(`No pending insight sources found${topic ? ` for topic: ${topic}` : ''}`);
  }

  logger.info({ sourceCount: sources.length, topic }, 'Starting insight synthesis');

  // 2. Group by topic for coherent synthesis
  const byTopic = groupByTopic(sources);
  const topicsIncluded = Object.keys(byTopic);

  // 3. Synthesize each topic group
  const allProposedRules: ProposedRule[] = [];
  const allGaps: string[] = [];
  let totalTokens = 0;

  for (const [topicName, topicSources] of Object.entries(byTopic)) {
    const { rules, gaps, tokensUsed } = await synthesizeTopic(
      topicName,
      topicSources
    );

    allProposedRules.push(...rules);
    allGaps.push(...gaps);
    totalTokens += tokensUsed;
  }

  const durationMs = Date.now() - startTime;

  // 4. Create synthesis run record
  const run = await db.createSynthesisRun({
    topic,
    source_ids: sources.map(s => s.id),
    topics_included: topicsIncluded,
    proposed_rules: allProposedRules,
    created_by: createdBy,
    model_used: ModelConfig.primary,
    tokens_used: totalTokens,
    synthesis_duration_ms: durationMs,
  });

  // 5. Run preview against historical interactions
  let preview: SynthesisPreviewResults | null = null;
  if (previewSampleSize > 0 && allProposedRules.length > 0) {
    try {
      preview = await previewSynthesizedRules(
        db,
        allProposedRules,
        previewSampleSize
      );

      const previewSummary = formatPreviewSummary(preview);
      await db.updateSynthesisPreview(run.id, preview, previewSummary);
    } catch (error) {
      logger.warn({ error, runId: run.id }, 'Failed to generate preview');
    }
  }

  logger.info({
    runId: run.id,
    rulesProposed: allProposedRules.length,
    sourcesProcessed: sources.length,
    durationMs,
    tokensUsed: totalTokens,
  }, 'Insight synthesis completed');

  return {
    run: { ...run, preview_results: preview },
    proposedRules: allProposedRules,
    preview,
    gaps: allGaps,
  };
}

/**
 * Apply an approved synthesis run - create rules and mark sources as synthesized
 * Also captures the resulting config version for tracking
 */
export async function applySynthesis(
  db: AddieDatabase,
  runId: number
): Promise<{ rules: AddieRule[]; run: SynthesisRun; configVersionId: number | null }> {
  const run = await db.getSynthesisRun(runId);
  if (!run) {
    throw new Error(`Synthesis run not found: ${runId}`);
  }

  if (run.status !== 'approved') {
    throw new Error(`Synthesis run must be approved before applying. Current status: ${run.status}`);
  }

  const createdRules: AddieRule[] = [];

  // Create each proposed rule
  for (const proposed of run.proposed_rules) {
    const rule = await db.createRule({
      rule_type: proposed.rule_type,
      name: proposed.name,
      content: proposed.content,
      priority: SYNTHESIZED_RULE_PRIORITY,
      created_by: 'synthesis',
    });
    createdRules.push(rule);
  }

  const ruleIds = createdRules.map(r => r.id);

  // Mark sources as synthesized
  await db.markSourcesSynthesized(run.source_ids, runId);

  // Update run with applied rule IDs
  const updatedRun = await db.applySynthesisRun(runId, ruleIds);

  // Invalidate config cache so next request gets new version
  invalidateConfigCache();

  // Get the new config version after rules are applied
  let configVersionId: number | null = null;
  try {
    const activeRules = await db.getActiveRules();
    const ruleSnapshots: RuleSnapshot[] = activeRules.map(r => ({
      id: r.id,
      rule_type: r.rule_type,
      name: r.name,
      content: r.content,
      priority: r.priority,
    }));
    const ruleIdList = activeRules.map(r => r.id);

    const configVersion = await getOrCreateConfigVersion(ruleIdList, ruleSnapshots);
    configVersionId = configVersion.version_id;

    // Link synthesis run to resulting config version
    await db.linkSynthesisToConfigVersion(runId, configVersionId);

    logger.info({
      runId,
      configVersionId,
      configHash: configVersion.config_hash,
    }, 'Synthesis linked to config version');
  } catch (error) {
    // Don't fail the whole operation if config versioning fails
    logger.warn({ error, runId }, 'Failed to link synthesis to config version');
  }

  logger.info({
    runId,
    rulesCreated: ruleIds.length,
    sourcesMarked: run.source_ids.length,
    configVersionId,
  }, 'Synthesis applied');

  return {
    rules: createdRules,
    run: updatedRun!,
    configVersionId,
  };
}

// ============== Helper Functions ==============

/**
 * Group sources by topic
 */
function groupByTopic(sources: InsightSource[]): Record<string, InsightSource[]> {
  const groups: Record<string, InsightSource[]> = {};

  for (const source of sources) {
    const topic = source.topic || 'general';
    if (!groups[topic]) {
      groups[topic] = [];
    }
    groups[topic].push(source);
  }

  return groups;
}

/**
 * Synthesize a single topic's sources into rules
 */
async function synthesizeTopic(
  topic: string,
  sources: InsightSource[]
): Promise<{ rules: ProposedRule[]; gaps: string[]; tokensUsed: number }> {
  const prompt = buildSynthesisPrompt(topic, sources);

  const result = await complete({
    prompt,
    system: SYNTHESIS_SYSTEM_PROMPT,
    maxTokens: 4096,
    model: 'primary',
    operationName: 'insight-synthesis',
  });

  const tokensUsed = (result.inputTokens || 0) + (result.outputTokens || 0);
  const responseText = result.text;

  // Parse response
  let parsed: ClaudeSynthesisResponse;
  try {
    const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                      responseText.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    logger.error({ error, topic, response: responseText }, 'Failed to parse synthesis response');
    throw new Error(`Failed to parse synthesis response for topic: ${topic}`);
  }

  return {
    rules: parsed.rules,
    gaps: parsed.gaps || [],
    tokensUsed,
  };
}

/**
 * Build the synthesis prompt for a topic
 */
function buildSynthesisPrompt(topic: string, sources: InsightSource[]): string {
  const sourcesFormatted = sources.map((s, i) => {
    let header = `### Source ${i + 1}`;
    if (s.author_name) {
      header += ` (${s.author_name}`;
      if (s.author_context) {
        header += ` - ${s.author_context}`;
      }
      header += ')';
    }
    header += `\nType: ${s.source_type}`;
    if (s.notes) {
      header += `\nContext: ${s.notes}`;
    }

    return `${header}\n\n${s.content}`;
  }).join('\n\n---\n\n');

  return `## Topic: ${topic}

Synthesize the following ${sources.length} source(s) into coherent knowledge rules for Addie.

${sourcesFormatted}

---

Now synthesize these sources into 1-3 focused knowledge rules. Remember:
- These become Addie's own beliefs (no attribution)
- Be concise but substantive
- Take clear positions
- Include the source IDs that informed each rule`;
}

/**
 * Preview how synthesized rules would affect historical interactions
 */
async function previewSynthesizedRules(
  db: AddieDatabase,
  proposedRules: ProposedRule[],
  sampleSize: number
): Promise<SynthesisPreviewResults> {
  // Get historical interactions with ratings
  const interactions = await db.getInteractionsForAnalysis({
    days: 30,
    limit: sampleSize,
  });

  if (interactions.length === 0) {
    return {
      predictions: [],
      summary: {
        likely_improved: 0,
        likely_unchanged: 0,
        likely_worse: 0,
        avg_improvement: 0,
      },
    };
  }

  // Format proposed rules for comparison
  const proposedRulesText = proposedRules
    .map(r => `## ${r.name}\n${r.content}`)
    .join('\n\n');

  const predictions: SynthesisPreviewPrediction[] = [];

  // Evaluate a sample of interactions
  const sampled = interactions.slice(0, Math.min(10, sampleSize));

  for (const interaction of sampled) {
    try {
      const result = await complete({
        prompt: `You are evaluating how new knowledge rules would affect an AI assistant's response.

## New Rules Being Added

${proposedRulesText}

## Original Interaction

User: ${interaction.input_text.substring(0, 500)}

Original Response: ${interaction.output_text.substring(0, 1000)}

${interaction.rating ? `Original Rating: ${interaction.rating}/5` : ''}

## Task

Would the new rules improve this response? Output JSON:
{
  "predicted_change": "Brief description of how response would change (or 'No significant change')",
  "improvement_score": 0.5,  // -1 (worse) to 1 (better), 0 = no change
  "confidence": 0.8
}`,
        maxTokens: 512,
        model: 'fast',
        operationName: 'synthesis-preview',
      });

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        predictions.push({
          interaction_id: interaction.id,
          original_response: interaction.output_text.substring(0, 200),
          predicted_change: parsed.predicted_change,
          improvement_score: parsed.improvement_score,
          confidence: parsed.confidence,
        });
      }
    } catch (error) {
      logger.warn({ error, interactionId: interaction.id }, 'Failed to evaluate interaction');
    }
  }

  // Calculate summary
  const summary = {
    likely_improved: predictions.filter(p => p.improvement_score > 0.2).length,
    likely_unchanged: predictions.filter(p => Math.abs(p.improvement_score) <= 0.2).length,
    likely_worse: predictions.filter(p => p.improvement_score < -0.2).length,
    avg_improvement: predictions.length > 0
      ? predictions.reduce((sum, p) => sum + p.improvement_score, 0) / predictions.length
      : 0,
  };

  return { predictions, summary };
}

/**
 * Format preview summary for display
 */
function formatPreviewSummary(preview: SynthesisPreviewResults): string {
  const { summary, predictions } = preview;
  const total = predictions.length;

  if (total === 0) {
    return 'No historical interactions available for preview.';
  }

  const avgScore = (summary.avg_improvement * 100).toFixed(0);
  const sign = summary.avg_improvement >= 0 ? '+' : '';

  return `Tested against ${total} historical interactions:
- ${summary.likely_improved} likely improved
- ${summary.likely_unchanged} unchanged
- ${summary.likely_worse} potentially worse
- Average impact: ${sign}${avgScore}%`;
}
