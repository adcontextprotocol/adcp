import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicRoot = join(process.cwd(), 'server/public');
const helperSource = readFileSync(join(publicRoot, 'content-image-upload.js'), 'utf8');

class BrowserEvent {
  type: string;
  bubbles: boolean;

  constructor(type: string, options: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = Boolean(options.bubbles);
  }
}

function loadHelper(extra: Record<string, unknown> = {}) {
  const providedWindow = (extra.window || {}) as Record<string, unknown>;
  const context = vm.createContext({
    URL,
    Event: BrowserEvent,
    ...extra,
    window: { AbortController, ...providedWindow },
  });
  vm.runInContext(helperSource, context);
  return (context.window as { ContentImageUpload: any }).ContentImageUpload;
}

function mountedHarness(fetchImpl: Function) {
  let slug = 'article-a';
  const listeners = new Map<string, Function>();
  const elements: Record<string, any> = {};
  for (const id of ['trigger', 'panel', 'file', 'alt', 'link', 'submit', 'cancel', 'status', 'hint', 'textarea']) {
    elements[id] = {
      id,
      classList: { add: vi.fn(), remove: vi.fn() },
      value: '',
      textContent: '',
      disabled: false,
      files: [],
      selectionStart: 0,
      selectionEnd: 0,
      addEventListener: (event: string, callback: Function) => listeners.set(`${id}:${event}`, callback),
      focus: vi.fn(),
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      dispatchEvent: vi.fn(),
    };
  }
  class TestFormData { append() {} }
  const helper = loadHelper({
    document: { getElementById: (id: string) => elements[id] },
    window: {
      AbortController,
      fetch: fetchImpl,
      FormData: TestFormData,
      crypto: { randomUUID: () => 'upload-id' },
    },
  });
  const uploader = helper.mount({
    triggerButtonId: 'trigger', panelId: 'panel', fileInputId: 'file', altInputId: 'alt',
    linkInputId: 'link', submitButtonId: 'submit', cancelButtonId: 'cancel', statusId: 'status',
    hintId: 'hint', textareaId: 'textarea', getSlug: () => slug,
  });
  return {
    elements,
    listeners,
    uploader,
    setSlug(value: string) { slug = value; },
  };
}

describe('content body image editor', () => {
  it.each(['my-content.html', 'admin-content.html'])('wires image insertion into %s', (file) => {
    const html = readFileSync(join(publicRoot, file), 'utf8');

    expect(html).toContain('<script src="/content-image-upload.js"></script>');
    expect(html).toContain('id="insertBodyImageBtn"');
    expect(html).toContain('id="bodyImageAlt" required');
    expect(html).toContain('id="bodyImageLink"');
    expect(html).toContain("getSlug: () => editingContent?.slug || ''");
    expect(html).toContain('.preview-pane img { max-width: 100%; height: auto; }');
  });

  it('keeps published body images within the article width', () => {
    const html = readFileSync(join(publicRoot, 'perspectives/article.html'), 'utf8');
    expect(html).toContain('.article-content img {');
    expect(html).toContain('max-width: 100%');
    expect(html).toContain('height: auto');
  });

  it('builds accessible image and linked-image Markdown with escaped alt text', () => {
    const helper = loadHelper();

    expect(helper.buildImageMarkdown(
      'https://agenticadvertising.org/api/perspectives/post/assets/panel.png',
      'Panel [at Cannes]',
      ''
    )).toBe('![Panel \\[at Cannes\\]](<https://agenticadvertising.org/api/perspectives/post/assets/panel.png>)');
    expect(helper.buildImageMarkdown(
      'https://agenticadvertising.org/image.png',
      'Whitepaper cover',
      'https://example.com/whitepaper'
    )).toBe('[![Whitepaper cover](<https://agenticadvertising.org/image.png>)](<https://example.com/whitepaper>)');
    expect(() => helper.buildImageMarkdown('https://example.com/image.png', 'Alt', 'javascript:alert(1)'))
      .toThrow(/absolute http:\/\/ or https:\/\//);
    expect(() => helper.buildImageMarkdown('https://example.com/image.png', 'Alt', 'https://user:secret@example.com/'))
      .toThrow('Link URL must not include credentials.');
    expect(() => helper.buildImageMarkdown('https://example.com/image.png', 'Alt', 'http://example.com/report'))
      .toThrow('Link URL must use https://.');
    expect(() => helper.buildImageMarkdown('https://example.com/image.png', ' ', ''))
      .toThrow('Alt text is required.');
  });

  it('uploads a uniquely named attachment and returns Markdown', async () => {
    const helper = loadHelper();
    const parts: Array<[string, unknown, string?]> = [];
    class TestFormData {
      append(name: string, value: unknown, filename?: string) {
        parts.push([name, value, filename]);
      }
    }
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ asset: { url: 'https://agenticadvertising.org/api/perspectives/story/assets/panel-unique.png' } }),
    });
    const file = { name: 'panel photo.png', type: 'image/png', size: 1024 };

    const result = await helper.uploadImage({
      file,
      slug: 'story slug',
      altText: 'Cannes panel',
      linkUrl: 'https://example.com/report',
      fetchImpl,
      FormDataImpl: TestFormData,
      randomUUID: () => 'unique-id',
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/content/story%20slug/assets', {
      method: 'POST',
      credentials: 'include',
      body: expect.any(TestFormData),
    });
    expect(parts).toEqual([
      ['file', file, 'panel-photo-unique-id.png'],
      ['asset_type', 'attachment', undefined],
    ]);
    expect(result.markdown).toContain('[![Cannes panel]');
    expect(helper.createUploadFilename('panel photo.png', () => 'second-id'))
      .toBe('panel-photo-second-id.png');
    expect(helper.createUploadFilename('panel photo.png', () => 'second-id'))
      .not.toBe(parts[0][2]);
  });

  it('validates images before upload and surfaces useful server failures', async () => {
    const helper = loadHelper();
    const fetchImpl = vi.fn();
    const base = {
      slug: 'story', altText: 'Alt', linkUrl: '', fetchImpl,
      FormDataImpl: class { append() {} }, randomUUID: () => 'id',
    };

    await expect(helper.uploadImage({ ...base, file: { name: 'x.svg', type: 'image/svg+xml', size: 10 } }))
      .rejects.toThrow('Choose a JPEG, PNG, WebP, or GIF image.');
    await expect(helper.uploadImage({ ...base, file: { name: 'x.png', type: 'image/png', size: helper.MAX_IMAGE_BYTES + 1 } }))
      .rejects.toThrow('Image files must be under 10MB.');
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(helper.uploadImage({ ...base, file: { name: 'x.png', type: 'image/png', size: 10 } }))
      .rejects.toThrow('You do not have permission');
  });

  it('replaces the captured selection, restores the caret, and dispatches input', () => {
    const helper = loadHelper();
    const events: BrowserEvent[] = [];
    const textarea = {
      value: 'Before selected after',
      selectionStart: 7,
      selectionEnd: 15,
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      dispatchEvent(event: BrowserEvent) { events.push(event); },
      focus: vi.fn(),
    };

    const caret = helper.insertMarkdown(textarea, '![Alt](<https://example.com/image.png>)', { start: 7, end: 15 });

    expect(textarea.value).toBe('Before ![Alt](<https://example.com/image.png>) after');
    expect(textarea.selectionStart).toBe(caret);
    expect(textarea.selectionEnd).toBe(caret);
    expect(events).toEqual([expect.objectContaining({ type: 'input', bubbles: true })]);
    expect(textarea.focus).toHaveBeenCalled();
  });

  it('disables insertion until the article has a slug', () => {
    let slug = '';
    const listeners = new Map<string, Function>();
    const classList = { add: vi.fn(), remove: vi.fn() };
    const elements: Record<string, any> = {};
    for (const id of ['trigger', 'panel', 'file', 'alt', 'link', 'submit', 'cancel', 'status', 'hint', 'textarea']) {
      elements[id] = {
        id, classList, value: '', textContent: '', disabled: false, selectionStart: 0, selectionEnd: 0,
        addEventListener: (event: string, callback: Function) => listeners.set(`${id}:${event}`, callback),
        focus: vi.fn(), setSelectionRange: vi.fn(), dispatchEvent: vi.fn(),
      };
    }
    const helper = loadHelper({ document: { getElementById: (id: string) => elements[id] } });
    const uploader = helper.mount({
      triggerButtonId: 'trigger', panelId: 'panel', fileInputId: 'file', altInputId: 'alt',
      linkInputId: 'link', submitButtonId: 'submit', cancelButtonId: 'cancel', statusId: 'status',
      hintId: 'hint', textareaId: 'textarea', getSlug: () => slug,
    });

    expect(elements.trigger.disabled).toBe(true);
    expect(elements.hint.textContent).toBe('Save as a draft before adding images.');
    slug = 'saved-story';
    uploader.refresh();
    expect(elements.trigger.disabled).toBe(false);
  });

  it('aborts and invalidates a pending upload when the editor closes or switches articles', async () => {
    let resolveFetch!: (value: unknown) => void;
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise(resolve => { resolveFetch = resolve; });
    });
    const { elements, listeners, uploader, setSlug } = mountedHarness(fetchImpl);
    elements.textarea.value = 'Article A';
    elements.textarea.selectionStart = elements.textarea.value.length;
    elements.textarea.selectionEnd = elements.textarea.value.length;
    listeners.get('trigger:click')?.();
    elements.file.files = [{ name: 'panel.png', type: 'image/png', size: 100 }];
    elements.file.value = 'panel.png';
    elements.alt.value = 'Panel';

    const pending = listeners.get('submit:click')?.();
    expect(requestSignal?.aborted).toBe(false);
    setSlug('article-b');
    uploader.close();
    expect(requestSignal?.aborted).toBe(true);

    resolveFetch({
      ok: true,
      status: 201,
      json: async () => ({ asset: { url: 'https://agenticadvertising.org/image.png' } }),
    });
    await pending;

    expect(elements.textarea.value).toBe('Article A');
    expect(elements.file.value).toBe('');
    expect(elements.alt.value).toBe('');
    expect(elements.link.value).toBe('');
  });

  it('preserves edits and upload fields when a pending upload fails', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchImpl = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
    const { elements, listeners } = mountedHarness(fetchImpl);
    elements.textarea.value = 'Original body';
    elements.textarea.selectionStart = elements.textarea.value.length;
    elements.textarea.selectionEnd = elements.textarea.value.length;
    listeners.get('trigger:click')?.();
    elements.file.files = [{ name: 'panel.png', type: 'image/png', size: 100 }];
    elements.file.value = 'panel.png';
    elements.alt.value = 'Panel';
    elements.link.value = 'https://example.com/report';

    const pending = listeners.get('submit:click')?.();
    elements.textarea.value = 'Original body plus edits made during upload';
    resolveFetch({ ok: false, status: 500, json: async () => ({ message: 'Storage unavailable' }) });
    await pending;

    expect(elements.textarea.value).toBe('Original body plus edits made during upload');
    expect(elements.file.value).toBe('panel.png');
    expect(elements.alt.value).toBe('Panel');
    expect(elements.link.value).toBe('https://example.com/report');
    expect(elements.status.textContent).toBe('Storage unavailable');
  });
});
