/**
 * Addie registry review - async quality control for community edits.
 *
 * After each community edit or new record creation, Addie reviews the change
 * and posts her assessment to the Slack thread. For malicious edits, she
 * auto-reverts and bans the editor.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { ModelConfig } from '../../config/models.js';
import { BrandDatabase } from '../../db/brand-db.js';
import { PropertyDatabase } from '../../db/property-db.js';
import { RegistryBansDatabase } from '../../db/registry-bans-db.js';
import {
  notifyAddieReview,
  notifyRegistryApproval,
  notifyRegistryBan,
} from '../../notifications/registry.js';

export interface ReviewResult {
  verdict: 'ok' | 'suspicious' | 'malicious';
  reason: string;
}

const brandDb = new BrandDatabase();
const propertyDb = new PropertyDatabase();
const bansDb = new RegistryBansDatabase();

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Compute a simple field-by-field diff between two snapshots.
 */
function diffSnapshots(
  oldSnap: Record<string, unknown>,
  newSnap: Record<string, unknown>
): string {
  const allKeys = new Set([...Object.keys(oldSnap), ...Object.keys(newSnap)]);
  const changes: string[] = [];

  for (const key of allKeys) {
    const oldVal = JSON.stringify(oldSnap[key] ?? null);
    const newVal = JSON.stringify(newSnap[key] ?? null);
    if (oldVal !== newVal) {
      changes.push(`- ${key}: ${oldVal} -> ${newVal}`);
    }
  }

  return changes.length > 0 ? changes.join('\n') : 'No visible changes';
}

/**
 * Call Claude to review a registry change.
 */
async function callReview(prompt: string): Promise<ReviewResult> {
  try {
    const response = await getClient().messages.create({
      model: ModelConfig.fast,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
      system: `You are a registry quality reviewer for AgenticAdvertising.org, a standards body for AI-powered advertising. You review community edits to the brand and property registries.

Respond with EXACTLY one JSON object: {"verdict": "ok" | "suspicious" | "malicious", "reason": "brief explanation"}

Verdicts:
- "ok": The edit looks legitimate and reasonable.
- "suspicious": Something seems off but isn't clearly malicious. Examples: removing useful data without explanation, unusual field values.
- "malicious": Clearly harmful. Examples: blanking all data, spam/SEO content, nonsensical values, obviously false brand relationships.

Be pragmatic. Most edits are fine. Only flag what genuinely looks wrong.`,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const parsed = JSON.parse(text);
    const validVerdicts = ['ok', 'suspicious', 'malicious'];
    if (validVerdicts.includes(parsed.verdict) && parsed.reason) {
      return { verdict: parsed.verdict, reason: parsed.reason };
    }
    return { verdict: 'ok', reason: 'Review completed (could not parse structured response)' };
  } catch (error) {
    logger.error({ error }, 'Registry review LLM call failed');
    return { verdict: 'ok', reason: 'Review skipped due to error' };
  }
}

/**
 * Review a new record creation. If approved, makes the record public.
 */
export async function reviewNewRecord(record: {
  entity_type: 'brand' | 'property';
  domain: string;
  editor_user_id: string;
  editor_email?: string;
  snapshot: Record<string, unknown>;
  slack_thread_ts?: string;
}): Promise<ReviewResult> {
  const prompt = `A community member (${record.editor_email || record.editor_user_id}) created a new ${record.entity_type} record for "${record.domain}".

Record data:
${JSON.stringify(record.snapshot, null, 2)}

Does this look like a legitimate ${record.entity_type} record? Check for spam, nonsensical data, or obviously fake entries.`;

  const result = await callReview(prompt);

  // Act on the verdict
  if (result.verdict === 'ok') {
    // Approve the record
    if (record.entity_type === 'brand') {
      await brandDb.approveBrand(record.domain);
    } else {
      await propertyDb.approveProperty(record.domain);
    }
    if (record.slack_thread_ts) {
      await notifyRegistryApproval({
        entity_type: record.entity_type,
        domain: record.domain,
        thread_ts: record.slack_thread_ts,
      });
    }
  } else if (result.verdict === 'suspicious') {
    // Approve but flag for admin review
    if (record.entity_type === 'brand') {
      await brandDb.approveBrand(record.domain);
    } else {
      await propertyDb.approveProperty(record.domain);
    }
    logger.warn({ domain: record.domain, entity_type: record.entity_type, reason: result.reason }, 'Suspicious new record approved with flag');
  } else if (result.verdict === 'malicious') {
    // Ban the editor and delete the record
    try {
      await bansDb.createEditBan({
        entity_type: record.entity_type,
        banned_user_id: record.editor_user_id,
        banned_email: record.editor_email,
        banned_by_user_id: 'system:addie',
        banned_by_email: 'addie@agenticadvertising.org',
        reason: `Auto-ban: ${result.reason}`,
      });
      // Delete the malicious record
      if (record.entity_type === 'brand') {
        await brandDb.deleteDiscoveredBrand(record.domain);
      } else {
        await propertyDb.deleteHostedPropertyByDomain(record.domain);
      }
      await notifyRegistryBan({
        entity_type: record.entity_type,
        banned_email: record.editor_email,
        reason: `Auto-ban: ${result.reason}`,
        banned_by_email: 'addie@agenticadvertising.org',
      });
    } catch (banError) {
      logger.error({ banError, domain: record.domain }, 'Failed to auto-ban after malicious new record');
    }
  }

  // Post review to Slack thread
  if (record.slack_thread_ts) {
    await notifyAddieReview({
      thread_ts: record.slack_thread_ts,
      verdict: result.verdict,
      reason: result.reason,
      domain: record.domain,
      action_taken: result.verdict === 'ok' ? 'Record approved'
        : result.verdict === 'malicious' ? 'Record hidden, editor banned'
        : undefined,
    });
  }

  return result;
}

/**
 * Review an edit to an existing record. If malicious, auto-reverts and bans.
 */
export async function reviewRegistryEdit(edit: {
  entity_type: 'brand' | 'property';
  domain: string;
  editor_user_id: string;
  editor_email?: string;
  edit_summary: string;
  old_snapshot: Record<string, unknown>;
  new_snapshot: Record<string, unknown>;
  revision_number: number;
  slack_thread_ts?: string;
}): Promise<ReviewResult> {
  const diff = diffSnapshots(edit.old_snapshot, edit.new_snapshot);

  const prompt = `A community member (${edit.editor_email || edit.editor_user_id}) edited the ${edit.entity_type} record for "${edit.domain}".

Edit summary: "${edit.edit_summary}"

Changes:
${diff}

Does this edit look reasonable? Check for vandalism, spam, or obviously incorrect changes.`;

  const result = await callReview(prompt);

  // Act on malicious edits
  if (result.verdict === 'malicious') {
    const rollbackTo = edit.revision_number - 1;
    if (rollbackTo >= 1) {
      try {
        // Auto-revert
        if (edit.entity_type === 'brand') {
          await brandDb.rollbackBrand(edit.domain, rollbackTo, {
            user_id: 'system:addie',
            email: 'addie@agenticadvertising.org',
            name: 'Addie (auto-revert)',
          });
        } else {
          await propertyDb.rollbackProperty(edit.domain, rollbackTo, {
            user_id: 'system:addie',
            email: 'addie@agenticadvertising.org',
            name: 'Addie (auto-revert)',
          });
        }

        // Auto-ban
        await bansDb.createEditBan({
          entity_type: edit.entity_type,
          banned_user_id: edit.editor_user_id,
          banned_email: edit.editor_email,
          entity_domain: edit.domain,
          banned_by_user_id: 'system:addie',
          banned_by_email: 'addie@agenticadvertising.org',
          reason: `Auto-ban: ${result.reason}`,
        });
        await notifyRegistryBan({
          entity_type: edit.entity_type,
          banned_email: edit.editor_email,
          entity_domain: edit.domain,
          reason: `Auto-ban: ${result.reason}`,
          banned_by_email: 'addie@agenticadvertising.org',
        });
      } catch (revertError) {
        logger.error({ revertError, domain: edit.domain }, 'Failed to auto-revert malicious edit');
      }
    }
  }

  // Post review to Slack thread
  if (edit.slack_thread_ts) {
    await notifyAddieReview({
      thread_ts: edit.slack_thread_ts,
      verdict: result.verdict,
      reason: result.reason,
      domain: edit.domain,
      action_taken: result.verdict === 'malicious' ? 'Edit reverted, editor banned' : undefined,
    });
  }

  return result;
}
