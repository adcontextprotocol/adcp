import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../public/oauth-complete.html', import.meta.url), 'utf8');
const CONTEXT = '11111111-2222-4333-8444-555555555555';

function render(query: Record<string, string>, page = html) {
  const script = page.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  if (!script) throw new Error('OAuth completion script missing');
  let link: { textContent?: string; href?: string } | undefined;
  const replace = vi.fn();
  const timer = vi.fn();
  const content = { innerHTML: '', querySelector: () => ({ replaceChildren(value: typeof link) { link = value; } }) };
  runInNewContext(script!, {
    URL, URLSearchParams,
    window: { location: { origin: 'https://buyer.example.test', search: '?' + new URLSearchParams(query), replace } },
    document: { getElementById: () => content, createElement: () => ({}) },
    setTimeout: timer,
  }, { timeout: 1000 });
  return { link, replace, timer };
}

describe('explicit owner recovery action', () => {
  it('constructs only the fixed local fresh-sign-in target and waits for an owner click', () => {
    const result = render({ agent_context_id: CONTEXT, return_to: '/dashboard?tab=agents' });
    expect(result.link?.textContent).toBe('Start a new sign-in');
    const target = new URL(result.link!.href!, 'https://buyer.example.test');
    expect(target.origin).toBe('https://buyer.example.test');
    expect(target.pathname).toBe('/api/oauth/agent/start');
    expect(target.searchParams.get('agent_context_id')).toBe(CONTEXT);
    expect(target.searchParams.get('fresh')).toBe('1');
    expect(target.searchParams.get('return_to')).toBe('/dashboard?tab=agents');
    expect(result.replace).not.toHaveBeenCalled();
    expect(result.timer).not.toHaveBeenCalled();
  });

  it.each(['SCRIPT', 'ScRiPt'])('executes the trusted completion page with %s tag spelling', tag => {
    const page = html.replaceAll('<script>', `<${tag}>`).replaceAll('</script>', `</${tag}>`);
    const result = render({ agent_context_id: CONTEXT, return_to: '/dashboard?tab=agents' }, page);
    const target = new URL(result.link!.href!, 'https://buyer.example.test');
    expect(result.link?.textContent).toBe('Start a new sign-in');
    expect(target.origin).toBe('https://buyer.example.test');
    expect(target.pathname).toBe('/api/oauth/agent/start');
    expect(target.searchParams.get('agent_context_id')).toBe(CONTEXT);
    expect(target.searchParams.get('fresh')).toBe('1');
    expect(target.searchParams.get('return_to')).toBe('/dashboard?tab=agents');
    expect(result.replace).not.toHaveBeenCalled();
    expect(result.timer).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.example/start', '//attacker.example/start', '<script>alert(1)</script>', ''])('rejects an invalid context %s', context => {
    expect(render({ agent_context_id: context }).link).toBeUndefined();
  });

  it.each(['https://attacker.example', '//attacker.example', '/\\attacker.example'])('does not carry unsafe return target %s', target => {
    const result = render({ agent_context_id: CONTEXT, return_to: target });
    expect(new URL(result.link!.href!, 'https://buyer.example.test').searchParams.has('return_to')).toBe(false);
  });
});
