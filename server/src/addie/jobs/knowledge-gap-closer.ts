/**
 * Knowledge Gap Closer
 *
 * When shadow evaluations find knowledge gaps, this job identifies
 * which documentation should be updated and generates the content.
 * Creates GitHub issues with proposed doc changes for human review.
 *
 * Runs every hour during business hours.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { getThreadService } from '../thread-service.js';
import { ModelConfig } from '../../config/models.js';

const logger = createLogger('knowledge-gap-closer');

export interface GapCloserResult {
  gaps_reviewed: number;
  issues_created: number;
  skipped: number;
  errors: number;
}

interface GapThread {
  thread_id: string;
  flag_reason: string;
  context: {
    shadow_eval_result: {
      knowledge_gap: boolean;
      gap_severity: string;
      gap_details: string;
      shadow_quality: string;
    };
    shadow_eval_question: string;
    shadow_eval_human_response: string;
    shadow_eval_shadow_response: string;
    shadow_eval_gap_issue_created?: boolean;
  };
}

/**
 * Find threads with knowledge gaps that haven't had issues created yet.
 * Only significant and critical gaps — minor ones aren't worth doc changes.
 */
async function findUnresolvedGaps(limit: number): Promise<GapThread[]> {
  const result = await query<GapThread>(
    `SELECT thread_id, flag_reason, context
     FROM addie_threads
     WHERE context->>'shadow_eval_status' = 'complete'
       AND (context->'shadow_eval_result'->>'knowledge_gap')::boolean = true
       AND context->'shadow_eval_result'->>'gap_severity' IN ('significant', 'critical')
       AND (context->>'shadow_eval_gap_issue_created') IS NULL
       AND flagged = TRUE
     ORDER BY
       CASE context->'shadow_eval_result'->>'gap_severity'
         WHEN 'critical' THEN 0
         WHEN 'significant' THEN 1
         ELSE 2
       END,
       updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Use Claude to determine which doc file should be updated and draft the content.
 */
async function planDocUpdate(
  client: Anthropic,
  question: string,
  humanResponse: string,
  gapDetails: string,
): Promise<{
  target_file: string;
  section: string;
  proposed_content: string;
  reasoning: string;
} | null> {
  const response = await client.messages.create({
    model: ModelConfig.fast,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `A knowledge gap was detected in Addie's documentation. A user asked a question, a human expert answered, but Addie couldn't have given the same answer.

## Question
"${question.substring(0, 300)}"

## Human Expert Answer (the ground truth)
${humanResponse.substring(0, 800)}

## Gap Details
${gapDetails}

## Task
Determine which AdCP documentation file should be updated and draft the missing content. The docs are organized as:
- docs/building/implementation/ — How to build with AdCP (task lifecycle, webhooks, async ops)
- docs/building/integration/ — Integration guides (MCP, A2A)
- docs/building/schemas-and-sdks.mdx — SDK and CLI usage
- docs/creative/ — Creative agent reference
- docs/signals/ — Signal provider reference
- docs/overview/ — Protocol overview and concepts
- docs/governance/ — Standards governance

Respond with ONLY a JSON object:
{
  "target_file": "docs/building/implementation/webhooks.mdx (best guess at which file)",
  "section": "Section heading where this should go",
  "proposed_content": "The actual content to add (markdown, 2-5 sentences, practical and specific)",
  "reasoning": "Why this file and section"
}

If the gap is about something that doesn't belong in docs (e.g., organizational knowledge, opinions), respond: {"target_file": "none", "section": "", "proposed_content": "", "reasoning": "explanation"}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonStr);
    if (parsed.target_file === 'none') return null;
    return parsed;
  } catch {
    logger.warn({ text }, 'Gap closer: Could not parse doc update plan');
    return null;
  }
}

/**
 * Create a GitHub issue with the proposed doc update.
 * Uses the GitHub API via environment variable.
 */
async function createGitHubIssue(
  gap: GapThread,
  plan: { target_file: string; section: string; proposed_content: string; reasoning: string },
): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'adcontextprotocol/adcp';

  if (!token) {
    logger.warn('Gap closer: GITHUB_TOKEN not set — logging issue instead of creating');
    logger.info({
      target_file: plan.target_file,
      section: plan.section,
      proposed_content: plan.proposed_content,
    }, 'Gap closer: Proposed doc update');
    return null;
  }

  const severity = gap.context.shadow_eval_result.gap_severity;
  const title = `docs: knowledge gap (${severity}) — ${plan.section}`;
  const body = `## Knowledge Gap Detected

**Severity:** ${severity}
**Gap:** ${gap.context.shadow_eval_result.gap_details}

### Context
A user asked: "${gap.context.shadow_eval_question?.substring(0, 200)}"

A human expert provided an answer that Addie's documentation didn't cover.

### Proposed Update

**File:** \`${plan.target_file}\`
**Section:** ${plan.section}

\`\`\`markdown
${plan.proposed_content}
\`\`\`

**Reasoning:** ${plan.reasoning}

---
*Auto-generated by Addie's shadow evaluation system. Thread: ${gap.thread_id}*`;

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        title,
        body,
        labels: ['documentation', 'knowledge-gap', `severity:${severity}`],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, status: response.status }, 'Gap closer: GitHub API error');
      return null;
    }

    const issue = await response.json() as { html_url: string };
    return issue.html_url;
  } catch (error) {
    logger.error({ error }, 'Gap closer: Failed to create GitHub issue');
    return null;
  }
}

/**
 * Main job runner. Reviews knowledge gaps, plans doc updates, creates issues.
 */
export async function runKnowledgeGapCloserJob(
  options: { limit: number } = { limit: 3 }
): Promise<GapCloserResult> {
  const result: GapCloserResult = { gaps_reviewed: 0, issues_created: 0, skipped: 0, errors: 0 };

  let gaps: GapThread[];
  try {
    gaps = await findUnresolvedGaps(options.limit);
  } catch (error) {
    logger.error({ error }, 'Gap closer: Failed to find gaps');
    return result;
  }

  if (gaps.length === 0) return result;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('Gap closer: ANTHROPIC_API_KEY not set');
    return result;
  }

  const client = new Anthropic({ apiKey });
  const threadService = getThreadService();

  for (const gap of gaps) {
    try {
      const ctx = gap.context;
      result.gaps_reviewed++;

      // Plan the doc update
      const plan = await planDocUpdate(
        client,
        ctx.shadow_eval_question || '',
        ctx.shadow_eval_human_response || '',
        ctx.shadow_eval_result.gap_details,
      );

      if (!plan) {
        // Not a doc-worthy gap (organizational knowledge, opinion, etc.)
        await threadService.patchThreadContext(gap.thread_id, {
          shadow_eval_gap_issue_created: false,
          shadow_eval_gap_reason: 'Not doc-worthy',
        });
        result.skipped++;
        continue;
      }

      // Create GitHub issue
      const issueUrl = await createGitHubIssue(gap, plan);

      // Mark as processed
      await threadService.patchThreadContext(gap.thread_id, {
        shadow_eval_gap_issue_created: true,
        shadow_eval_gap_issue_url: issueUrl,
        shadow_eval_gap_target_file: plan.target_file,
      });

      if (issueUrl) {
        result.issues_created++;
        logger.info({ threadId: gap.thread_id, issueUrl, targetFile: plan.target_file },
          'Gap closer: Created GitHub issue');
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error({ error, threadId: gap.thread_id }, 'Gap closer: Failed to process gap');
      result.errors++;
    }
  }

  return result;
}
