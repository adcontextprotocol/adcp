import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlPath = resolve(__dirname, '../../server/public/community/profile-edit.html');
const jsPath = resolve(__dirname, '../../server/public/community/profile-edit.js');
const htmlContent = readFileSync(htmlPath, 'utf-8');
const jsContent = readFileSync(jsPath, 'utf-8');

interface ProfileEditWindow extends Window {
  __APP_CONFIG__: Record<string, unknown>;
  ProfileEdit: {
    slugify: (text: string) => string;
    escapeHtml: (str: string) => string;
    fieldValue: (id: string) => string;
    fieldChecked: (id: string) => boolean;
    populateForm: (profile: Record<string, unknown>) => void;
    populateMemberFields: (
      memberProfile: Record<string, unknown> | null,
      billingData: Record<string, unknown> | null,
      populateFormValues: boolean
    ) => void;
    handleSubmit: (e: Event) => Promise<void>;
    restructureForIndividual: () => void;
    initPortraitWidget: () => Promise<void>;
    adaptForMemberState: () => void;
    showToast: (message: string, type: string) => void;
    setPersonalAccount: (val: boolean) => void;
    setUserData: (val: Record<string, unknown> | null) => void;
  };
  fetch: (...args: unknown[]) => Promise<unknown>;
}

function createDOM(): JSDOM & { window: ProfileEditWindow } {
  // Strip the <script src> tag so we control when JS runs
  const html = htmlContent.replace(
    /<script src="\/community\/profile-edit\.js"><\/script>/,
    ''
  );
  const dom = new JSDOM(html, {
    url: 'https://agenticadvertising.org/account',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const win = dom.window as unknown as ProfileEditWindow;

  // Inject APP_CONFIG before running JS (prevents auth redirect)
  win.__APP_CONFIG__ = {
    user: { id: 'test-user-123', first_name: 'Test', last_name: 'User' },
  };

  // Stub fetch globally
  win.fetch = () => Promise.resolve({ ok: false, status: 404 });

  // Execute the extracted JS
  win.eval(jsContent);

  return dom as JSDOM & { window: ProfileEditWindow };
}

describe('profile-edit: pure helpers', () => {
  let win: ProfileEditWindow;

  beforeEach(() => {
    const dom = createDOM();
    win = dom.window;
  });

  it('slugify converts text to URL-safe slug', () => {
    expect(win.ProfileEdit.slugify('Jane Doe')).toBe('jane-doe');
    expect(win.ProfileEdit.slugify('José García')).toBe('jose-garcia');
    expect(win.ProfileEdit.slugify('  hello world  ')).toBe('hello-world');
    expect(win.ProfileEdit.slugify('CAPS & symbols!')).toBe('caps-symbols');
  });

  it('escapeHtml escapes HTML entities including quotes for attribute safety', () => {
    expect(win.ProfileEdit.escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
    expect(win.ProfileEdit.escapeHtml("O'Brien")).toBe('O&#39;Brien');
    expect(win.ProfileEdit.escapeHtml('')).toBe('');
    expect(win.ProfileEdit.escapeHtml(null as unknown as string)).toBe('');
  });

  it('fieldValue returns empty string for missing elements', () => {
    expect(win.ProfileEdit.fieldValue('nonexistent-field')).toBe('');
  });

  it('fieldValue returns trimmed value for existing elements', () => {
    const el = win.document.getElementById('field-headline') as HTMLInputElement;
    el.value = '  VP of Programmatic  ';
    expect(win.ProfileEdit.fieldValue('field-headline')).toBe('VP of Programmatic');
  });

  it('fieldChecked returns false for missing elements', () => {
    expect(win.ProfileEdit.fieldChecked('nonexistent-field')).toBe(false);
  });
});

describe('profile-edit: restructureForIndividual', () => {
  let win: ProfileEditWindow;

  beforeEach(() => {
    const dom = createDOM();
    win = dom.window;
    // Make member directory section visible (as loadProfile would)
    const el = win.document.getElementById('member-directory-section');
    if (el) el.style.display = 'block';
  });

  it('preserves all expected form field IDs after restructure', () => {
    win.ProfileEdit.restructureForIndividual();

    const expectedIds = [
      'field-first-name', 'field-last-name',
      'field-is-public', 'field-slug', 'field-headline', 'field-bio',
      'field-city', 'field-linkedin-url', 'field-twitter-url',
      'field-github-username', 'field-coffee-chat', 'field-intros',
      'field-contact-email', 'field-contact-phone', 'field-contact-website',
      'offering-consulting', 'offering-other',
    ];
    const missing = expectedIds.filter(id => !win.document.getElementById(id));
    expect(missing).toEqual([]);
  });

  it('preserves portrait section', () => {
    win.ProfileEdit.restructureForIndividual();
    expect(win.document.getElementById('portrait-generate')).not.toBeNull();
    expect(win.document.getElementById('section-portrait-and-addie')).not.toBeNull();
  });

  it('changes page title to "Your profile"', () => {
    win.ProfileEdit.restructureForIndividual();
    expect(win.document.querySelector('.edit-title')?.textContent).toBe('Your profile');
  });

  it('moves city field into About section', () => {
    win.ProfileEdit.restructureForIndividual();
    const aboutSection = win.document.getElementById('section-about');
    expect(aboutSection?.querySelector('#field-city')).not.toBeNull();
  });

  it('creates Expertise and interests section', () => {
    win.ProfileEdit.restructureForIndividual();
    const form = win.document.getElementById('profile-form')!;
    const titles = Array.from(form.querySelectorAll('.edit-section-title')).map(
      el => el.textContent
    );
    expect(titles).toContain('Expertise and interests');
  });

  it('creates Public listing section', () => {
    win.ProfileEdit.restructureForIndividual();
    const form = win.document.getElementById('profile-form')!;
    const titles = Array.from(form.querySelectorAll('.edit-section-title')).map(
      el => el.textContent
    );
    expect(titles).toContain('Public listing');
  });

  it('renames Preferences to Networking', () => {
    win.ProfileEdit.restructureForIndividual();
    const form = win.document.getElementById('profile-form')!;
    const titles = Array.from(form.querySelectorAll('.edit-section-title')).map(
      el => el.textContent
    );
    expect(titles).toContain('Networking');
    expect(titles).not.toContain('Preferences');
  });
});

describe('profile-edit: handleSubmit', () => {
  let win: ProfileEditWindow;

  beforeEach(() => {
    const dom = createDOM();
    win = dom.window;
  });

  it('builds correct payload from form values', async () => {
    // Use populateForm to set tags and form values in one call
    win.ProfileEdit.populateForm({
      is_public: true,
      slug: 'jane-doe',
      headline: 'VP of Programmatic',
      bio: 'A test bio',
      city: 'New York',
      linkedin_url: 'https://linkedin.com/in/janedoe',
      open_to_coffee_chat: true,
      open_to_intros: false,
      expertise: ['programmatic', 'rtb'],
      interests: ['ai'],
    });
    win.ProfileEdit.setPersonalAccount(false);

    let capturedPayload: Record<string, unknown> | null = null;
    win.fetch = async (url: unknown, opts: { body?: string }) => {
      if (url === '/api/me/community-profile') {
        capturedPayload = JSON.parse(opts.body!);
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false };
    };

    const event = new win.Event('submit', { cancelable: true });
    await win.ProfileEdit.handleSubmit(event);

    expect(capturedPayload).toMatchObject({
      is_public: true,
      slug: 'jane-doe',
      headline: 'VP of Programmatic',
      bio: 'A test bio',
      expertise: ['programmatic', 'rtb'],
      interests: ['ai'],
      city: 'New York',
      open_to_coffee_chat: true,
      open_to_intros: false,
    });
    expect(capturedPayload!.offerings).toBeUndefined();
    expect(capturedPayload!.contact_email).toBeUndefined();
  });

  it('includes offerings and contact fields for personal accounts', async () => {
    win.ProfileEdit.setPersonalAccount(true);
    (win.document.getElementById('offering-consulting') as HTMLInputElement).checked = true;
    (win.document.getElementById('offering-other') as HTMLInputElement).checked = false;
    (win.document.getElementById('field-contact-email') as HTMLInputElement).value = 'jane@example.com';

    let capturedPayload: Record<string, unknown> | null = null;
    win.fetch = async (url: unknown, opts: { body?: string }) => {
      if (url === '/api/me/community-profile') {
        capturedPayload = JSON.parse(opts.body!);
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false };
    };

    const event = new win.Event('submit', { cancelable: true });
    await win.ProfileEdit.handleSubmit(event);

    expect(capturedPayload!.offerings).toEqual(['consulting']);
    expect(capturedPayload!.contact_email).toBe('jane@example.com');
  });

  it('shows error toast on failed save', async () => {
    win.fetch = async () => ({
      ok: false,
      json: async () => ({ error: 'Slug taken' }),
    });

    const event = new win.Event('submit', { cancelable: true });
    await win.ProfileEdit.handleSubmit(event);

    const toast = win.document.getElementById('toast')!;
    expect(toast.textContent).toBe('Slug taken');
  });

  it('re-enables save button after error', async () => {
    win.fetch = async () => ({
      ok: false,
      json: async () => ({ error: 'fail' }),
    });

    const event = new win.Event('submit', { cancelable: true });
    await win.ProfileEdit.handleSubmit(event);

    const btn = win.document.getElementById('save-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save changes');
  });
});

describe('profile-edit: name fields', () => {
  let win: ProfileEditWindow;

  beforeEach(() => {
    const dom = createDOM();
    win = dom.window;
  });

  it('populateForm fills name fields from userData', () => {
    win.ProfileEdit.setUserData({ first_name: 'Ben', last_name: 'Massé' });
    win.ProfileEdit.populateForm({});

    expect((win.document.getElementById('field-first-name') as HTMLInputElement).value).toBe('Ben');
    expect((win.document.getElementById('field-last-name') as HTMLInputElement).value).toBe('Massé');
  });

  it('handleSubmit calls PUT /api/me/name when name changes', async () => {
    win.ProfileEdit.setUserData({ first_name: 'Old', last_name: 'Name' });
    (win.document.getElementById('field-first-name') as HTMLInputElement).value = 'New';
    (win.document.getElementById('field-last-name') as HTMLInputElement).value = 'Name';

    let namePayload: Record<string, unknown> | null = null;
    win.fetch = async (url: unknown, opts: { body?: string }) => {
      if (url === '/api/me/name') {
        namePayload = JSON.parse(opts.body!);
        return { ok: true, json: async () => ({}) };
      }
      if (url === '/api/me/community-profile') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false };
    };

    const event = new win.Event('submit', { cancelable: true });
    await win.ProfileEdit.handleSubmit(event);

    expect(namePayload).toEqual({ first_name: 'New', last_name: 'Name' });
  });

  it('handleSubmit does not call PUT /api/me/name when name is unchanged', async () => {
    win.ProfileEdit.setUserData({ first_name: 'Same', last_name: 'Name' });
    (win.document.getElementById('field-first-name') as HTMLInputElement).value = 'Same';
    (win.document.getElementById('field-last-name') as HTMLInputElement).value = 'Name';

    let nameCalled = false;
    win.fetch = async (url: unknown, opts: { body?: string }) => {
      if (url === '/api/me/name') {
        nameCalled = true;
        return { ok: true, json: async () => ({}) };
      }
      if (url === '/api/me/community-profile') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false };
    };

    const event = new win.Event('submit', { cancelable: true });
    await win.ProfileEdit.handleSubmit(event);

    expect(nameCalled).toBe(false);
  });
});

describe('profile-edit: initPortraitWidget', () => {
  let win: ProfileEditWindow;

  beforeEach(() => {
    const dom = createDOM();
    win = dom.window;
  });

  it('returns early when portrait-generate element is missing', async () => {
    const el = win.document.getElementById('portrait-generate');
    el?.parentNode?.removeChild(el);

    // Should not throw
    await win.ProfileEdit.initPortraitWidget();
  });

  it('shows ineligible message on 402 response', async () => {
    win.fetch = async () => ({ ok: false, status: 402 });

    await win.ProfileEdit.initPortraitWidget();

    const ineligible = win.document.getElementById('portrait-ineligible')!;
    expect(ineligible.style.display).toBe('');
    expect(win.document.getElementById('portrait-ineligible-msg')!.textContent).toContain('Paid members');
  });

  it('shows ineligible message when canGenerate is false', async () => {
    win.fetch = async () => ({
      ok: true,
      json: async () => ({ canGenerate: false }),
    });

    await win.ProfileEdit.initPortraitWidget();

    const msg = win.document.getElementById('portrait-ineligible-msg')!;
    expect(msg.textContent).toContain('Active membership required');
  });

  it('disables generate button when no generations remaining', async () => {
    win.fetch = async () => ({
      ok: true,
      json: async () => ({
        canGenerate: true,
        maxMonthlyGenerations: 3,
        generationsThisMonth: 3,
      }),
    });

    await win.ProfileEdit.initPortraitWidget();

    const btn = win.document.getElementById('portrait-generate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe('profile-edit: populateMemberFields', () => {
  let win: ProfileEditWindow;

  beforeEach(() => {
    const dom = createDOM();
    win = dom.window;
    const el = win.document.getElementById('member-directory-section');
    if (el) el.style.display = 'block';
  });

  it('disables offerings for non-subscriber without profile', () => {
    win.ProfileEdit.populateMemberFields(null, null, false);

    const status = win.document.getElementById('member-directory-status')!;
    expect(status.style.display).toBe('block');
    expect(status.innerHTML).toContain('Manage organization membership');
    expect((win.document.getElementById('offering-consulting') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows "save to create listing" for subscriber without profile', () => {
    const billing = { subscription: { status: 'active' } };
    win.ProfileEdit.populateMemberFields(null, billing, false);

    const status = win.document.getElementById('member-directory-status')!;
    expect(status.innerHTML).toContain('Save your profile');
    expect((win.document.getElementById('offering-consulting') as HTMLInputElement).disabled).toBe(false);
  });

  it('populates form values when populateFormValues is true', () => {
    const member = {
      offerings: ['consulting', 'other'],
      contact_email: 'test@example.com',
      contact_phone: '+15551234567',
      contact_website: 'https://example.com',
      is_public: true,
      slug: 'test-user',
    };
    const billing = { subscription: { status: 'active' } };

    win.ProfileEdit.populateMemberFields(member, billing, true);

    expect((win.document.getElementById('offering-consulting') as HTMLInputElement).checked).toBe(true);
    expect((win.document.getElementById('offering-other') as HTMLInputElement).checked).toBe(true);
    expect((win.document.getElementById('field-contact-email') as HTMLInputElement).value).toBe('test@example.com');
  });

  it('does NOT overwrite form values when populateFormValues is false', () => {
    (win.document.getElementById('field-contact-email') as HTMLInputElement).value = 'user-typed@example.com';

    const member = {
      offerings: ['consulting'],
      contact_email: 'from-server@example.com',
      is_public: true,
      slug: 'test-user',
    };
    const billing = { subscription: { status: 'active' } };

    win.ProfileEdit.populateMemberFields(member, billing, false);

    expect((win.document.getElementById('field-contact-email') as HTMLInputElement).value).toBe('user-typed@example.com');
  });

  it('shows green status for public + subscribed member', () => {
    const member = { is_public: true, slug: 'jane', offerings: [] };
    const billing = { subscription: { status: 'active' } };

    win.ProfileEdit.populateMemberFields(member, billing, false);

    const status = win.document.getElementById('member-directory-status')!;
    expect(status.innerHTML).toContain('/members/jane');
  });
});
