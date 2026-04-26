/**
 * Admin endpoint backing the suggested-prompts metrics dashboard.
 *
 * Reads the addie_prompt_telemetry table aggregated per rule_id so
 * operators can answer:
 *   - which rules fire most often
 *   - which ones get clicked vs ignored
 *   - which ones are getting auto-suppressed (signal that the prompt
 *     isn't earning its slot)
 *
 * Click data is heuristic: incoming user messages whose text matches a
 * known rule prompt verbatim count as a click. ~95% accurate, useful
 * for relative ranking even though the absolute CTR may be slightly
 * understated by users who paraphrase the prompt.
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getRuleMetrics } from '../../db/addie-prompt-telemetry-db.js';
import { ALL_RULES } from '../../addie/home/builders/rules/prompt-rules.js';

const logger = createLogger('admin-prompt-metrics');

export function setupPromptMetricsRoutes(apiRouter: Router): void {
  // GET /api/admin/prompt-metrics
  // Returns one row per rule_id with shown/clicked/CTR/suppression data.
  // Rules that have never been shown still appear (as zero rows) so the
  // dashboard surfaces dormant rules — a prompt no one sees is as
  // important to know about as one no one clicks.
  apiRouter.get('/prompt-metrics', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const metrics = await getRuleMetrics();
      const seen = new Set(metrics.map((m) => m.rule_id));
      const dormant = ALL_RULES.filter((r) => !seen.has(r.id)).map((r) => ({
        rule_id: r.id,
        distinct_users_shown: 0,
        total_shown: 0,
        total_clicked: 0,
        ctr: 0,
        distinct_users_suppressed: 0,
        last_shown_at: null,
        last_clicked_at: null,
      }));

      // Decorate with prompt copy + priority so the dashboard can
      // display them without fetching the registry separately.
      const ruleIndex = new Map(ALL_RULES.map((r) => [r.id, r]));
      const decorated = [...metrics, ...dormant].map((m) => {
        const rule = ruleIndex.get(m.rule_id);
        return {
          ...m,
          label: rule?.label ?? null,
          prompt: rule?.prompt ?? null,
          priority: rule?.priority ?? null,
          decay: rule?.decay ?? null,
        };
      });

      res.json({ rules: decorated });
    } catch (error) {
      logger.warn({ error }, 'Failed to load prompt metrics');
      res.status(500).json({ error: 'Failed to load prompt metrics' });
    }
  });
}
