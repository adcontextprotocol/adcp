import { createLogger } from '../../logger.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import type { DigestContent, DigestEditEntry } from '../../db/digest-db.js';
import { buildDigestContent } from './digest-builder.js';

const logger = createLogger('digest-editor');

export interface DigestEditResult {
  content: DigestContent;
  summary: string;
}

const EDITORS_NOTE_PATTERN = /^editor'?s?\s*note[:\s]/i;

const VALID_OPS = new Set([
  'remove_news', 'update_intro', 'set_editors_note', 'clear_editors_note',
  'set_subject', 'reorder_news', 'update_why_it_matters', 'multiple', 'clarify',
]);

const MAX_EDIT_DEPTH = 2;
const MAX_BATCH_EDITS = 5;
const MAX_TEXT_LENGTH = 500;

/**
 * Apply an editorial instruction to the digest content.
 * Returns the updated content and a human-readable summary of changes.
 */
export async function applyDigestEdit(
  current: DigestContent,
  instruction: string,
  editorName: string,
): Promise<DigestEditResult> {
  const trimmed = instruction.trim();

  // Direct editor's note — no LLM needed
  if (EDITORS_NOTE_PATTERN.test(trimmed)) {
    const noteText = trimmed.replace(EDITORS_NOTE_PATTERN, '').trim().slice(0, MAX_TEXT_LENGTH);
    const content = addEditEntry(
      { ...current, editorsNote: noteText },
      editorName,
      `Set editor's note`,
    );
    return { content, summary: `Added editor's note: "${noteText.slice(0, 80)}${noteText.length > 80 ? '...' : ''}"` };
  }

  // Full regeneration
  if (/^regenerate$/i.test(trimmed)) {
    return regenerateDigest(current, editorName);
  }

  // LLM-interpreted edit
  if (!isLLMConfigured()) {
    return { content: current, summary: "I can't process free-form edits without an LLM configured." };
  }

  return interpretAndApplyEdit(current, trimmed, editorName);
}

/**
 * Regenerate the entire digest from scratch, preserving editor's note and edit history.
 */
async function regenerateDigest(
  current: DigestContent,
  editorName: string,
): Promise<DigestEditResult> {
  logger.info('Regenerating digest content');

  let fresh;
  try {
    fresh = await buildDigestContent();
  } catch (err) {
    logger.error({ error: err }, 'Failed to regenerate digest content');
    return { content: current, summary: 'Regeneration failed — try again later.' };
  }

  // Preserve editorial additions
  const content = addEditEntry(
    {
      ...fresh,
      editorsNote: current.editorsNote,
      emailSubject: current.emailSubject,
      editHistory: current.editHistory,
    },
    editorName,
    'Regenerated all content',
  );

  return { content, summary: 'Regenerated the full digest with fresh content. Editor\'s note and subject line preserved.' };
}

/**
 * Use the LLM to interpret a free-form edit instruction and apply it.
 */
async function interpretAndApplyEdit(
  current: DigestContent,
  instruction: string,
  editorName: string,
): Promise<DigestEditResult> {
  const contentSummary = summarizeForEdit(current);

  const result = await complete({
    system: `You are Addie, editing a weekly digest for AgenticAdvertising.org based on editorial feedback.

Given the current digest content and an editor's instruction, return a JSON object describing the edit to apply.

Available operations:
- {"op": "remove_news", "index": 0} — Remove a news article by index (0-based)
- {"op": "update_intro", "guidance": "..."} — Regenerate the intro with specific guidance
- {"op": "set_editors_note", "text": "..."} — Set or update the editor's note
- {"op": "clear_editors_note"} — Remove the editor's note
- {"op": "set_subject", "text": "..."} — Set a custom email subject line
- {"op": "reorder_news", "indices": [2, 0, 1]} — Reorder news articles
- {"op": "update_why_it_matters", "index": 0, "text": "..."} — Update a specific article's "why it matters"
- {"op": "multiple", "edits": [...]} — Apply multiple operations (max 5, no nesting)

If the instruction is unclear, return {"op": "clarify", "question": "..."}.

Respond with ONLY valid JSON, no markdown fences.`,
    prompt: `Current digest:\n${contentSummary}\n\nEditor's instruction: "${instruction}"`,
    maxTokens: 500,
    model: 'fast',
    operationName: 'digest-edit-interpret',
  });

  try {
    const cleaned = result.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');
    const edit = JSON.parse(cleaned);

    // Validate op before executing
    if (!edit.op || !VALID_OPS.has(String(edit.op))) {
      return { content: current, summary: `I didn't understand that. Try "remove the first article", "editor's note: ...", or "regenerate".` };
    }

    return executeEdit(current, edit, instruction, editorName, 0);
  } catch {
    logger.warn('Failed to parse edit instruction');
    return { content: current, summary: "I couldn't parse that instruction. Try being more specific — e.g., \"remove the first article\" or \"editor's note: Don't miss our town hall.\"" };
  }
}

/**
 * Execute a parsed edit operation against the digest content.
 */
async function executeEdit(
  current: DigestContent,
  edit: Record<string, unknown>,
  originalInstruction: string,
  editorName: string,
  depth: number,
): Promise<DigestEditResult> {
  if (depth > MAX_EDIT_DEPTH) {
    return { content: current, summary: 'Edit nesting too deep.' };
  }

  if (!VALID_OPS.has(String(edit.op))) {
    return { content: current, summary: `Unknown edit operation. Try "remove the first article", "editor's note: ...", or "regenerate".` };
  }

  const updated = { ...current, news: [...current.news] };

  switch (edit.op) {
    case 'remove_news': {
      const idx = typeof edit.index === 'number' ? edit.index : -1;
      if (idx >= 0 && idx < updated.news.length) {
        const removed = updated.news.splice(idx, 1)[0];
        const content = addEditEntry(updated, editorName, `Removed article: ${removed.title}`);
        return { content, summary: `Removed "${removed.title}" from the digest.` };
      }
      return { content: current, summary: `Article index ${idx} is out of range (${current.news.length} articles).` };
    }

    case 'update_intro': {
      const guidance = typeof edit.guidance === 'string' ? edit.guidance.slice(0, MAX_TEXT_LENGTH) : '';
      if (!guidance || !isLLMConfigured()) {
        return { content: current, summary: "Can't regenerate intro without guidance or LLM." };
      }
      const introResult = await complete({
        system: `You are Addie, the friendly AI assistant for AgenticAdvertising.org (AAO). Rewrite the weekly digest intro based on the editor's guidance. Lead with community activity. Be warm, concise, and specific. No emojis. 1-2 sentences only.`,
        prompt: `Current intro: "${current.intro}"\n\nEditor's guidance: "${guidance}"\n\nWorking groups: ${current.workingGroups.length}, new members: ${current.newMembers.length}, conversations: ${current.conversations.length}, news: ${current.news.length}.`,
        maxTokens: 150,
        model: 'fast',
        operationName: 'digest-edit-intro',
      });
      updated.intro = introResult.text;
      const content = addEditEntry(updated, editorName, `Updated intro`);
      return { content, summary: `Updated the intro based on your guidance.` };
    }

    case 'set_editors_note': {
      const text = typeof edit.text === 'string' ? edit.text.slice(0, MAX_TEXT_LENGTH) : '';
      if (!text) return { content: current, summary: 'No text provided for editor\'s note.' };
      updated.editorsNote = text;
      const content = addEditEntry(updated, editorName, `Set editor's note`);
      return { content, summary: `Set editor's note: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"` };
    }

    case 'clear_editors_note': {
      delete updated.editorsNote;
      const content = addEditEntry(updated, editorName, `Cleared editor's note`);
      return { content, summary: 'Removed the editor\'s note.' };
    }

    case 'set_subject': {
      const text = typeof edit.text === 'string' ? edit.text.slice(0, 100) : '';
      if (!text) return { content: current, summary: 'No text provided for subject line.' };
      updated.emailSubject = text;
      const content = addEditEntry(updated, editorName, `Set email subject`);
      return { content, summary: `Set email subject to: "${text}"` };
    }

    case 'reorder_news': {
      const indices = Array.isArray(edit.indices) ? edit.indices : [];
      const uniqueIndices = new Set(indices);
      if (
        indices.length === updated.news.length
        && uniqueIndices.size === indices.length
        && indices.every((i: unknown) => typeof i === 'number' && i >= 0 && i < updated.news.length)
      ) {
        updated.news = (indices as number[]).map((i) => current.news[i]);
        const content = addEditEntry(updated, editorName, 'Reordered articles');
        return { content, summary: `Reordered articles: ${updated.news.map((n) => n.title).join(', ')}` };
      }
      return { content: current, summary: 'Invalid article indices for reorder.' };
    }

    case 'update_why_it_matters': {
      const idx = typeof edit.index === 'number' ? edit.index : -1;
      const text = typeof edit.text === 'string' ? edit.text.slice(0, MAX_TEXT_LENGTH) : '';
      if (!text) return { content: current, summary: 'No text provided.' };
      if (idx >= 0 && idx < updated.news.length) {
        updated.news[idx] = { ...updated.news[idx], whyItMatters: text };
        const content = addEditEntry(updated, editorName, `Updated "why it matters" for: ${updated.news[idx].title}`);
        return { content, summary: `Updated "why it matters" for "${updated.news[idx].title}".` };
      }
      return { content: current, summary: `Article index ${idx} is out of range.` };
    }

    case 'multiple': {
      const edits = Array.isArray(edit.edits) ? edit.edits : [];
      if (edits.length > MAX_BATCH_EDITS) {
        return { content: current, summary: `Too many edits at once (max ${MAX_BATCH_EDITS}). Try one at a time.` };
      }
      // Prevent nested multiple operations
      if (edits.some((e: Record<string, unknown>) => e.op === 'multiple')) {
        return { content: current, summary: 'Nested batch edits are not supported.' };
      }
      let result: DigestEditResult = { content: updated, summary: '' };
      const summaries: string[] = [];
      for (const subEdit of edits) {
        if (typeof subEdit === 'object' && subEdit !== null && VALID_OPS.has(String(subEdit.op))) {
          result = await executeEdit(result.content, subEdit as Record<string, unknown>, originalInstruction, editorName, depth + 1);
          if (result.summary) summaries.push(result.summary);
        }
      }
      return { content: result.content, summary: summaries.join(' ') };
    }

    case 'clarify': {
      const question = typeof edit.question === 'string' ? edit.question.slice(0, MAX_TEXT_LENGTH) : 'Could you clarify what you\'d like to change?';
      return { content: current, summary: question };
    }

    default:
      return { content: current, summary: `Unknown edit operation. Try "remove the first article", "editor's note: ...", or "regenerate".` };
  }
}

function addEditEntry(content: DigestContent, editorName: string, description: string): DigestContent {
  const entry: DigestEditEntry = {
    editedBy: editorName,
    editedAt: new Date().toISOString(),
    description,
  };
  return {
    ...content,
    editHistory: [...(content.editHistory || []), entry],
  };
}

/**
 * Produce a concise summary of digest content for the LLM edit interpreter.
 */
function summarizeForEdit(content: DigestContent): string {
  const parts: string[] = [];
  parts.push(`Intro: "${content.intro}"`);

  if (content.editorsNote) {
    parts.push(`Editor's note: "${content.editorsNote}"`);
  }

  if (content.news.length > 0) {
    parts.push('News articles:');
    content.news.forEach((item, i) => {
      parts.push(`  [${i}] "${item.title}" — ${item.whyItMatters}`);
    });
  }

  if (content.workingGroups.length > 0) {
    parts.push(`Working groups: ${content.workingGroups.map((wg) => wg.name).join(', ')}`);
  }

  parts.push(`New members: ${content.newMembers.length}, Conversations: ${content.conversations.length}`);

  if (content.emailSubject) {
    parts.push(`Email subject: "${content.emailSubject}"`);
  }

  return parts.join('\n');
}
