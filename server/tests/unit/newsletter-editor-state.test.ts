import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { EditionRecord, NewsletterConfig } from '../../src/newsletters/config.js';
import type { DigestContent } from '../../src/db/digest-db.js';

const mocks = vi.hoisted(() => ({
  buildDigestContent: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'admin_01', email: 'admin@example.test', is_admin: true } as typeof req.user;
    next();
  },
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../src/newsletters/send-pipeline.js', () => ({ sendNewsletter: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));
vi.mock('../../src/addie/services/digest-builder.js', () => ({
  buildDigestContent: mocks.buildDigestContent,
}));

import {
  markFieldEdited,
  markItemEdited,
  preserveEditorState,
  recordDismissedUrl,
} from '../../src/newsletters/editor-state.js';
import { applyDigestEdit } from '../../src/addie/services/digest-editor.js';

function freshBuild(): DigestContent {
  return {
    contentVersion: 2,
    openingTake: 'Fresh generated opening.',
    whatToWatch: [
      { title: 'Fresh A', url: 'https://news.example/a', summary: 'A', whyItMatters: 'Fresh take A', tags: [] },
      { title: 'Fresh B', url: 'https://news.example/b', summary: 'B', whyItMatters: 'Fresh take B', tags: [] },
      { title: 'Removed C', url: 'https://news.example/c', summary: 'C', whyItMatters: 'Fresh take C', tags: [] },
    ],
    fromTheInside: [],
    voices: [],
    newMembers: [],
    shareableTake: 'Fresh shareable.',
    dateFlavor: 'Fresh flavor.',
    generatedAt: '2026-11-17T00:00:00Z',
  };
}

/** A draft an editor has worked on. */
function editedDraft(): DigestContent {
  let draft: DigestContent = {
    contentVersion: 2,
    openingTake: 'Editor rewrote the opening.\n\nSecond paragraph.',
    whatToWatch: [
      markItemEdited({ title: 'Old A', url: 'https://news.example/a/', summary: 'A', whyItMatters: 'Editor take on A', tags: [] }, 'ed@example.test'),
      { title: 'Old D', url: 'https://news.example/d', summary: 'D', whyItMatters: 'Generated take on D', tags: [] },
    ],
    fromTheInside: [],
    voices: [],
    newMembers: [],
    shareableTake: 'Editor shareable.',
    dateFlavor: 'Generated flavor (not edited).',
    editorsNote: 'Note from the editor.',
    emailSubject: 'Custom subject',
    customSections: [{ id: 'custom_1', title: 'Custom', body: 'Body', position: 0 }],
    hiddenSections: ['voices'],
    pastedContent: undefined,
    coverImageUrl: 'https://aao.example/digest/2026-11-17/cover.png?v=abc',
    editHistory: [{ editedBy: 'ed@example.test', editedAt: '2026-11-16T00:00:00Z', description: 'Edited' }],
    generatedAt: '2026-11-16T00:00:00Z',
  };
  draft = markFieldEdited(draft, 'openingTake', 'shareableTake');
  draft = recordDismissedUrl(draft, 'https://news.example/c');
  return draft;
}

function expectEditsKept(result: DigestContent) {
  expect(result.openingTake).toBe('Editor rewrote the opening.\n\nSecond paragraph.');
  expect(result.shareableTake).toBe('Editor shareable.');
  expect(result.editorsNote).toBe('Note from the editor.');
  expect(result.emailSubject).toBe('Custom subject');
  expect(result.customSections).toEqual([{ id: 'custom_1', title: 'Custom', body: 'Body', position: 0 }]);
  expect(result.hiddenSections).toEqual(['voices']);
  expect(result.coverImageUrl).toBe('https://aao.example/digest/2026-11-17/cover.png?v=abc');
  // Edited item replaces its regenerated counterpart (matched by URL).
  const a = result.whatToWatch.find((i) => i.url.includes('/a'));
  expect(a?.whyItMatters).toBe('Editor take on A');
  // Removed item stays removed.
  expect(result.whatToWatch.some((i) => i.url.includes('/c'))).toBe(false);
  // Untouched generated content is refreshed.
  expect(result.dateFlavor).toBe('Fresh flavor.');
  expect(result.whatToWatch.some((i) => i.title === 'Fresh B')).toBe(true);
  expect(result.whatToWatch.some((i) => i.title === 'Old D')).toBe(false);
}

describe('preserveEditorState', () => {
  it('keeps editor-owned fields and edits, refreshes the rest', () => {
    expectEditsKept(preserveEditorState(editedDraft(), freshBuild()));
  });

  it('regenerates an Opening Take nobody edited', () => {
    const draft = { ...freshBuild(), openingTake: 'Old generated opening.' };
    expect(preserveEditorState(draft, freshBuild()).openingTake).toBe('Fresh generated opening.');
  });

  it('keeps pasted content and the edit history without duplicating it', () => {
    const draft = { ...editedDraft(), pastedContent: '# Pasted' };
    const result = preserveEditorState(draft, freshBuild());
    expect(result.pastedContent).toBe('# Pasted');
    expect(result.editHistory).toHaveLength(1);
  });

  it('keeps an edited item the new build no longer has', () => {
    const draft = {
      ...freshBuild(),
      whatToWatch: [markItemEdited({ title: 'Gone', url: 'https://news.example/gone', summary: '', whyItMatters: 'Kept', tags: [] }, 'ed')],
    };
    const result = preserveEditorState(draft, freshBuild());
    expect(result.whatToWatch.map((i) => i.title)).toContain('Gone');
  });

  it('filters dismissed candidates out of the pool and included items', () => {
    const result = preserveEditorState(
      { dismissedIds: ['x1'] },
      { candidatePool: { decisions: [{ id: 'x1' }, { id: 'x2' }] }, decisions: [{ id: 'x1' }, { id: 'x3' }] },
    ) as { candidatePool: { decisions: Array<{ id: string }> }; decisions: Array<{ id: string }> };
    expect(result.candidatePool.decisions.map((d) => d.id)).toEqual(['x2']);
    expect(result.decisions.map((d) => d.id)).toEqual(['x3']);
  });
});

describe('cherry-picked sections (The Build)', () => {
  it('keeps included picks and does not offer them again in the pool', () => {
    const prev = {
      statusLine: 'old',
      decisions: [{ id: 'd1', title: 'Picked' }],
      candidatePool: { decisions: [{ id: 'd2' }] },
    };
    const fresh = {
      statusLine: 'new',
      decisions: [],
      candidatePool: { decisions: [{ id: 'd1', title: 'Picked' }, { id: 'd3' }] },
    };
    const result = preserveEditorState(prev, fresh) as typeof fresh;
    expect(result.decisions).toEqual([{ id: 'd1', title: 'Picked' }]);
    expect(result.candidatePool.decisions.map((d) => d.id)).toEqual(['d3']);
    expect(result.statusLine).toBe('new');
  });
});

describe('editing an article URL', () => {
  it('does not let regenerate bring the original article back', async () => {
    const { thePromptConfig } = await import('../../src/newsletters/the-prompt/index.js');
    const draft = freshBuild();
    const edited = thePromptConfig.itemOperations!.whatToWatch.editItem(
      draft, 0, { url: 'https://news.example/a-better-source' }, 'ed',
    ) as DigestContent;
    const result = preserveEditorState(edited, freshBuild());
    const urls = result.whatToWatch.map((i) => i.url);
    expect(urls).toContain('https://news.example/a-better-source');
    expect(urls).not.toContain('https://news.example/a');
  });
});

describe('Slack "regenerate" keeps editor state', () => {
  beforeEach(() => {
    mocks.buildDigestContent.mockReset();
    mocks.buildDigestContent.mockResolvedValue(freshBuild());
  });

  it('preserves the same fields as the admin path', async () => {
    const result = await applyDigestEdit(editedDraft(), 'regenerate', 'slack-editor');
    expectEditsKept(result.content);
    expect(result.content.editHistory).toHaveLength(2);
    expect(result.content.editHistory?.[1].description).toBe('Regenerated all content');
  });
});

describe('admin "Regenerate" keeps editor state', () => {
  function edition(content: unknown): EditionRecord {
    return {
      id: 7,
      edition_date: new Date('2026-11-17T00:00:00Z'),
      status: 'draft',
      content,
      approved_by: null,
      approved_at: null,
      review_channel_id: null,
      review_message_ts: null,
      perspective_id: null,
      created_at: new Date('2026-11-17T00:00:00Z'),
      sent_at: null,
      send_stats: null,
    };
  }

  async function makeApp(config: NewsletterConfig) {
    const { createNewsletterAdminRoutes } = await import('../../src/newsletters/admin-routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/newsletters/the_prompt', createNewsletterAdminRoutes(config));
    return app;
  }

  function makeConfig(current: EditionRecord) {
    const db = {
      getCurrent: vi.fn().mockResolvedValue(current),
      updateContent: vi.fn(async (_id: number, content: unknown) => ({ ...current, content })),
    };
    const config = {
      id: 'the_prompt',
      name: 'The Prompt',
      editableFields: ['openingTake', 'editorsNote', 'shareableTake', 'emailSubject', 'dateFlavor'],
      cadence: { generateHourET: 7, sendHourET: 10, shouldRunToday: () => false },
      sections: [],
      db,
      buildContent: vi.fn(async () => freshBuild()),
      generateSubject: () => 'Subject',
    } as unknown as NewsletterConfig;
    return { config, db };
  }

  it('regenerate preserves edits', async () => {
    const { config, db } = makeConfig(edition(editedDraft()));
    const app = await makeApp(config);
    const res = await request(app).post('/api/admin/newsletters/the_prompt/editions/7/regenerate');
    expect(res.status).toBe(200);
    expectEditsKept(db.updateContent.mock.calls[0][1] as DigestContent);
  });

  it('a direct field edit is marked so a later regenerate keeps it', async () => {
    const { config, db } = makeConfig(edition(freshBuild()));
    const app = await makeApp(config);
    const res = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/7/edit')
      .send({ field: 'openingTake', value: 'Hand-written opening.' });
    expect(res.status).toBe(200);
    const saved = db.updateContent.mock.calls[0][1] as DigestContent;
    expect(saved.editedFields).toContain('openingTake');
    expect(preserveEditorState(saved, freshBuild()).openingTake).toBe('Hand-written opening.');
  });
});
