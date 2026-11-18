/**
 * Editor-owned state on a newsletter draft.
 *
 * "Regenerate" rebuilds the machine-generated content of a draft. Anything an
 * editor wrote, chose or removed must survive it. The admin route and the
 * Slack "regenerate" instruction used to each keep their own short list of
 * fields, and both lost edits (the Opening Take, pasted content, the cover,
 * hidden sections...). Both now call `preserveEditorState`.
 *
 * What counts as editor-owned:
 * - Fields only an editor ever sets: the editor's note, subject override,
 *   custom sections, hidden sections, dismissed items, pasted content, the
 *   cover image URL and the edit history.
 * - Fields the builder generates but an editor changed: recorded in
 *   `editedFields` by the edit routes (`markFieldEdited`). An Opening Take the
 *   editor never touched is regenerated; one they rewrote is kept.
 * - Items an editor edited (`editedAt`, set by `markItemEdited`) replace the
 *   regenerated item with the same `id` or URL, or are kept if the new build
 *   no longer has it.
 * - Items an editor removed (`dismissedIds`, `dismissedUrls`) stay removed.
 *
 * Content is treated as an opaque record so The Prompt and The Build share it.
 */

import { normalizeEditionUrl } from './the-prompt/edition-rules.js';

type Content = Record<string, unknown>;
type Item = Record<string, unknown>;

/** Fields that only ever hold editor input; always carried over. */
export const ALWAYS_EDITOR_OWNED_FIELDS = [
  'editorsNote',
  'emailSubject',
  'customSections',
  'hiddenSections',
  'dismissedIds',
  'dismissedUrls',
  'pastedContent',
  'coverImageUrl',
  'editHistory',
  'editedFields',
] as const;

/** Record that an editor changed a generated field, so regenerate keeps it. */
export function markFieldEdited<T extends object>(content: T, ...fields: string[]): T {
  const c = content as Content;
  const edited = new Set(Array.isArray(c.editedFields) ? (c.editedFields as string[]) : []);
  for (const field of fields) edited.add(field);
  return { ...content, editedFields: [...edited] } as T;
}

/** Stamp an item as edited by an editor. */
export function markItemEdited<T extends object>(item: T, editor: string, at: Date = new Date()): T {
  return { ...item, editedBy: editor, editedAt: at.toISOString() };
}

/** Remember a removed item's URL so regenerate does not bring it back. */
export function recordDismissedUrl<T extends object>(content: T, url: string | undefined): T {
  const key = url ? normalizeEditionUrl(url) : '';
  if (!key) return content;
  const c = content as Content;
  const urls = new Set(Array.isArray(c.dismissedUrls) ? (c.dismissedUrls as string[]) : []);
  urls.add(key);
  return { ...content, dismissedUrls: [...urls] } as T;
}

function isItemArray(value: unknown): value is Item[] {
  return Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function itemUrl(item: Item): string {
  const url = item.url ?? item.releaseUrl ?? item.ctaUrl;
  return typeof url === 'string' ? normalizeEditionUrl(url) : '';
}

function sameItem(a: Item, b: Item): boolean {
  if (a.id !== undefined && a.id !== null && a.id === b.id) return true;
  const ua = itemUrl(a);
  return ua !== '' && ua === itemUrl(b);
}

function isDismissed(item: Item, dismissedIds: Set<string>, dismissedUrls: Set<string>): boolean {
  if (typeof item.id === 'string' && dismissedIds.has(item.id)) return true;
  const url = itemUrl(item);
  return url !== '' && dismissedUrls.has(url);
}

/**
 * Carry editor-owned state from `previous` onto freshly built content.
 * Returns a new object; neither input is mutated.
 */
export function preserveEditorState<T>(previous: unknown, fresh: T): T {
  const prev = (previous || {}) as Content;
  const next: Content = { ...(fresh as Content) };

  for (const field of ALWAYS_EDITOR_OWNED_FIELDS) {
    if (prev[field] !== undefined) next[field] = prev[field];
  }

  const editedFields = Array.isArray(prev.editedFields) ? (prev.editedFields as string[]) : [];
  for (const field of editedFields) {
    if (field in prev) next[field] = prev[field];
  }

  const dismissedIds = new Set(Array.isArray(prev.dismissedIds) ? (prev.dismissedIds as string[]) : []);
  const dismissedUrls = new Set(Array.isArray(prev.dismissedUrls) ? (prev.dismissedUrls as string[]) : []);

  const ownedKeys = new Set<string>([...ALWAYS_EDITOR_OWNED_FIELDS, ...editedFields]);

  // Edited items win over their regenerated counterparts; removed items stay out.
  for (const [key, prevValue] of Object.entries(prev)) {
    if (ownedKeys.has(key) || !isItemArray(prevValue)) continue;
    const edited = prevValue.filter((item) => typeof item.editedAt === 'string');
    if (edited.length === 0) continue;
    const freshValue = next[key];
    const freshItems = isItemArray(freshValue) ? freshValue : [];
    const used = new Set<Item>();
    const merged = freshItems.map((item) => {
      const match = edited.find((e) => !used.has(e) && sameItem(e, item));
      if (!match) return item;
      used.add(match);
      return match;
    });
    for (const e of edited) if (!used.has(e)) merged.push(e);
    next[key] = merged;
  }

  // Cherry-picked sections (The Build): when the fresh build offers a
  // candidate pool, the included items for a pooled section were chosen by
  // the editor. Keep them, and take them out of the fresh pool so they are
  // not offered twice.
  const freshPool = next.candidatePool;
  if (freshPool && typeof freshPool === 'object' && !Array.isArray(freshPool)) {
    const pool = { ...(freshPool as Record<string, unknown>) };
    for (const key of Object.keys(pool)) {
      if (ownedKeys.has(key)) continue;
      const picked = prev[key];
      if (!isItemArray(picked) || picked.length === 0) continue;
      const freshItems = isItemArray(next[key]) ? (next[key] as Item[]) : [];
      const extra = freshItems.filter((item) => !picked.some((p) => sameItem(p, item)));
      next[key] = [...picked, ...extra];
      const poolItems = pool[key];
      if (isItemArray(poolItems)) {
        pool[key] = poolItems.filter((item) => !picked.some((p) => sameItem(p, item)));
      }
    }
    next.candidatePool = pool;
  }

  if (dismissedIds.size > 0 || dismissedUrls.size > 0) {
    for (const [key, value] of Object.entries(next)) {
      if (ownedKeys.has(key) || !isItemArray(value)) continue;
      next[key] = value.filter((item) => !isDismissed(item, dismissedIds, dismissedUrls));
    }
    const pool = next.candidatePool as Record<string, unknown> | undefined;
    if (pool && typeof pool === 'object') {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(pool)) {
        filtered[key] = isItemArray(value)
          ? value.filter((item) => !isDismissed(item, dismissedIds, dismissedUrls))
          : value;
      }
      next.candidatePool = filtered;
    }
  }

  return next as T;
}
