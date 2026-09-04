import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function validationDetailFunction(): Promise<(domain: string) => Promise<void>> {
  const source = await readFile(new URL('../../public/publisher-home.html', import.meta.url), 'utf8');
  const start = source.indexOf('async function showValidationDetail(');
  if (start < 0) throw new Error('Missing showValidationDetail');
  const brace = source.indexOf('{', start);
  let depth = 0;
  let end = brace;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}' && --depth === 0) { end += 1; break; }
  }
  return new Function(`${source.slice(start, end)}; return showValidationDetail;`)() as
    (domain: string) => Promise<void>;
}

function validationPanel() {
  return {
    classList: {
      contains: vi.fn().mockReturnValue(true),
      add: vi.fn(),
      remove: vi.fn(),
    },
    innerHTML: '',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publisher validation detail', () => {
  it('turns a missing adagents.json response into an actionable builder link', async () => {
    const panel = validationPanel();
    vi.stubGlobal('document', { getElementById: () => panel });
    vi.stubGlobal('escapeHtml', (value: string) => value);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        data: { validation: { status_code: 404, errors: [] } },
      }),
    }));

    const showValidationDetail = await validationDetailFunction();
    await showValidationDetail('publisher.example');

    expect(panel.innerHTML).toContain('adagents.json not found');
    expect(panel.innerHTML).toContain('https://publisher.example/.well-known/adagents.json');
    expect(panel.innerHTML).toContain('/adagents/builder?domain=publisher.example');
  });

  it('labels malformed JSON as a parse error rather than exposing an internal field name', async () => {
    const panel = validationPanel();
    vi.stubGlobal('document', { getElementById: () => panel });
    vi.stubGlobal('escapeHtml', (value: string) => value);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        data: { validation: { status_code: 200, errors: [{ field: 'json', message: 'Invalid JSON' }] } },
      }),
    }));

    const showValidationDetail = await validationDetailFunction();
    await showValidationDetail('publisher.example');

    expect(panel.innerHTML).toContain('<strong>Parse error:</strong> Invalid JSON');
    expect(panel.innerHTML).not.toContain('<strong>json:</strong>');
  });

  it('preserves a delegated-manager scope error even when the direct fetch returned 404', async () => {
    const panel = validationPanel();
    vi.stubGlobal('document', { getElementById: () => panel });
    vi.stubGlobal('escapeHtml', (value: string) => value);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          validation: {
            status_code: 404,
            errors: [{ field: 'managerdomain_scope', message: 'Manager does not explicitly cover this publisher' }],
          },
        },
      }),
    }));

    const showValidationDetail = await validationDetailFunction();
    await showValidationDetail('publisher.example');

    expect(panel.innerHTML).toContain('<h3>Validation errors</h3>');
    expect(panel.innerHTML).toContain('Manager does not explicitly cover this publisher');
    expect(panel.innerHTML).not.toContain('adagents.json not found');
  });
});
