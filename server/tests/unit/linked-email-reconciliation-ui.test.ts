import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/dashboard-settings.html', import.meta.url), 'utf8');
const scriptStart = source.indexOf('    var accountPreferences = null;');
const scriptEnd = source.indexOf('    // ==========================================\n    // Notifications', scriptStart);
if (scriptStart < 0 || scriptEnd < 0) throw new Error('Linked email script not found');
const documents: JSDOM[] = [];
const mutationSelector = '.make-primary-btn, #openLinkEmailBtn, #linkEmailBtn, #linkEmailInput';
const supportMessage = 'We could not confirm the provider update. Contact support for reconciliation before changing email again.';

function response(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function emailStatus(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: 'user_credential',
    primary_email: 'primary@example.test',
    aliases: [{ email: 'alias@example.test' }],
    pending: [],
    reconciliation_required: false,
    ...overrides,
  };
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function loadControls(savedStorage?: Storage) {
  const dom = new JSDOM(source, { url: 'https://agenticadvertising.org/dashboard-settings.html' });
  documents.push(dom);
  const document = dom.window.document;
  const fetchMock = vi.fn();
  const showToast = vi.fn();
  const confirmMock = vi.fn(() => true);
  const sessionStorage = savedStorage ?? dom.window.sessionStorage;
  const newOperationId = vi.fn(randomUUID);
  const functions = new Function('document', 'window', 'fetch', 'confirm', `
    ${source.slice(scriptStart, scriptEnd)}
    return { loadLinkedEmails, setPrimaryEmail, openLinkEmailModal, sendLinkVerification };
  `)(document, {
    sessionStorage,
    crypto: { randomUUID: newOperationId },
    ProfileEdit: {
      showToast,
      escapeHtml(value: string) {
        const span = document.createElement('span');
        span.textContent = value;
        return span.innerHTML;
      },
    },
  }, fetchMock, confirmMock) as {
    loadLinkedEmails: () => Promise<void>;
    setPrimaryEmail: (email: string) => Promise<void>;
    openLinkEmailModal: () => void;
    sendLinkVerification: () => Promise<void>;
  };

  function expectDisabled(disabled: boolean) {
    const controls = document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(mutationSelector);
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const control of controls) expect(control.disabled, control.id || control.className).toBe(disabled);
  }

  async function loadReady() {
    fetchMock.mockResolvedValueOnce(response(emailStatus()));
    await functions.loadLinkedEmails();
    expectDisabled(false);
  }

  function enterEmail() {
    functions.openLinkEmailModal();
    (document.getElementById('linkEmailInput') as HTMLInputElement).value = 'new@example.test';
  }

  return { document, fetchMock, showToast, confirmMock, sessionStorage, newOperationId, expectDisabled, loadReady, enterEmail, ...functions };
}

afterEach(() => {
  for (const dom of documents.splice(0)) dom.window.close();
});

describe('linked email reconciliation UI', () => {
  it('persists a caller operation before sending and reuses it after a lost response and reload', async () => {
    const first = loadControls();
    await first.loadReady();
    first.fetchMock.mockImplementationOnce(async (_url, options) => {
      const sent = JSON.parse(options.body);
      expect(JSON.parse(first.sessionStorage.getItem('member-primary-email:user_credential')!))
        .toEqual({ email: 'alias@example.test', operation_id: sent.operation_id });
      throw new Error('Response lost');
    });
    await first.setPrimaryEmail('alias@example.test');
    first.expectDisabled(true);
    const original = JSON.parse(first.fetchMock.mock.calls[1][1].body);

    const reload = loadControls(first.sessionStorage);
    await reload.loadReady();
    reload.fetchMock.mockResolvedValueOnce(response({ primary_email: 'alias@example.test', operation_id: original.operation_id }))
      .mockResolvedValueOnce(response(emailStatus({ primary_email: 'alias@example.test' })));
    await reload.setPrimaryEmail('alias@example.test');
    expect(JSON.parse(reload.fetchMock.mock.calls[1][1].body)).toEqual(original);
    expect(reload.newOperationId).not.toHaveBeenCalled();
    expect(first.sessionStorage.getItem('member-primary-email:user_credential')).toBeNull();
  });

  it('keeps lock contention retryable with the same caller operation instead of entering reconciliation', async () => {
    const controls = loadControls();
    await controls.loadReady();
    controls.fetchMock.mockResolvedValueOnce(response({ error: 'credential_busy', retryable: true, message: 'Please retry.' }, 409));
    await controls.setPrimaryEmail('alias@example.test');
    controls.expectDisabled(false);
    const original = JSON.parse(controls.fetchMock.mock.calls[1][1].body);
    controls.fetchMock.mockResolvedValueOnce(response({ primary_email: 'alias@example.test', operation_id: original.operation_id }))
      .mockResolvedValueOnce(response(emailStatus()));
    await controls.setPrimaryEmail('alias@example.test');
    expect(JSON.parse(controls.fetchMock.mock.calls[2][1].body)).toEqual(original);
    expect(controls.newOperationId).toHaveBeenCalledOnce();
  });

  it.each([409, 502, 503])('starts a new caller operation after a stored terminal failure (%i)', async (status) => {
    const controls = loadControls();
    await controls.loadReady();
    controls.fetchMock.mockResolvedValueOnce(response({
      error: 'Email change failed', message: 'Your email was not changed. Start a new request.', reconciliation_required: false,
    }, status));
    await controls.setPrimaryEmail('alias@example.test');
    controls.expectDisabled(false);
    const original = JSON.parse(controls.fetchMock.mock.calls[1][1].body);
    expect(controls.sessionStorage.getItem('member-primary-email:user_credential')).toBeNull();
    controls.fetchMock.mockRejectedValueOnce(new Error('Response lost'));
    await controls.setPrimaryEmail('alias@example.test');
    expect(JSON.parse(controls.fetchMock.mock.calls[2][1].body).operation_id).not.toBe(original.operation_id);
    expect(controls.newOperationId).toHaveBeenCalledTimes(2);
  });

  it('does not send an email mutation if its caller operation cannot be persisted', async () => {
    const controls = loadControls();
    await controls.loadReady();
    const storage = Object.getPrototypeOf(controls.sessionStorage);
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    try {
      await controls.setPrimaryEmail('alias@example.test');
      expect(controls.fetchMock).toHaveBeenCalledOnce();
      controls.expectDisabled(true);
    } finally { setItem.mockRestore(); }
  });

  it('keeps an unknown server outcome disabled without inventing reconciliation state', async () => {
    const controls = loadControls();
    await controls.loadReady();
    controls.fetchMock.mockResolvedValueOnce(response({ status_unknown: true, message: 'Reload to check the outcome.' }, 503));
    await controls.setPrimaryEmail('alias@example.test');
    controls.expectDisabled(true);
    expect(controls.document.getElementById('linkedEmailStatusMessage')?.textContent).toContain('Reload to check the outcome.');
  });

  it('scopes persisted caller operations to the exact authenticated credential', async () => {
    const first = loadControls();
    await first.loadReady();
    first.fetchMock.mockRejectedValueOnce(new Error('Response lost'));
    await first.setPrimaryEmail('alias@example.test');
    const original = JSON.parse(first.fetchMock.mock.calls[1][1].body);
    const other = loadControls(first.sessionStorage);
    other.fetchMock.mockResolvedValueOnce(response(emailStatus({ credential_id: 'user_other' })));
    await other.loadLinkedEmails();
    other.fetchMock.mockRejectedValueOnce(new Error('Response lost'));
    await other.setPrimaryEmail('alias@example.test');
    expect(JSON.parse(other.fetchMock.mock.calls[1][1].body).operation_id).not.toBe(original.operation_id);
  });

  it('disables mutations before and during the initial authoritative status load', async () => {
    const controls = loadControls();
    controls.expectDisabled(true);
    controls.enterEmail();
    await controls.sendLinkVerification();
    await controls.setPrimaryEmail('alias@example.test');
    expect(controls.fetchMock).not.toHaveBeenCalled();
    expect(controls.confirmMock).not.toHaveBeenCalled();

    const pending = deferredResponse();
    controls.fetchMock.mockReturnValueOnce(pending.promise);
    const load = controls.loadLinkedEmails();
    controls.expectDisabled(true);
    pending.resolve(response(emailStatus()));
    await load;
    controls.expectDisabled(false);
  });

  it('restores reconciliation on page load and renders provider-safe support text without HTML execution', async () => {
    const controls = loadControls();
    const message = supportMessage + ' <img src=x onerror=alert(1)>';
    controls.fetchMock.mockResolvedValueOnce(response(emailStatus({ reconciliation_required: true, message })));
    await controls.loadLinkedEmails();

    controls.expectDisabled(true);
    const notice = controls.document.getElementById('linkedEmailStatus')!;
    expect(notice.style.display).toBe('block');
    expect(notice.textContent).toContain(message);
    expect(notice.querySelector('img')).toBeNull();
    expect(notice.querySelector('a')?.href).toBe('mailto:support@agenticadvertising.org');
    controls.openLinkEmailModal();
    expect(controls.document.getElementById('linkEmailModal')?.classList.contains('show')).toBe(false);
  });

  it.each([409, 503])('keeps all controls disabled after a primary mutation requires reconciliation (%s)', async (status) => {
    const controls = loadControls();
    await controls.loadReady();
    controls.fetchMock.mockResolvedValueOnce(response({
      error: 'provider_mutation_reconciliation_required',
      message: supportMessage,
      operation_id: 'operation-test',
      reconciliation_required: true,
    }, status));
    await controls.setPrimaryEmail('alias@example.test');

    controls.expectDisabled(true);
    expect(controls.showToast).toHaveBeenLastCalledWith(supportMessage, 'error');
    expect(controls.document.getElementById('linkedEmailStatusMessage')?.textContent).toContain(supportMessage);
    controls.enterEmail();
    await controls.setPrimaryEmail('alias@example.test');
    await controls.sendLinkVerification();
    expect(controls.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains reconciliation after the link-email finally block and modal open attempts', async () => {
    const controls = loadControls();
    await controls.loadReady();
    controls.enterEmail();
    controls.fetchMock.mockResolvedValueOnce(response({
      error: 'provider_mutation_reconciliation_required',
      message: supportMessage,
      reconciliation_required: true,
    }, 503));
    await controls.sendLinkVerification();

    controls.expectDisabled(true);
    expect(controls.showToast).toHaveBeenLastCalledWith(supportMessage, 'error');
    expect(controls.document.getElementById('linkEmailWarningMessage')?.textContent).toContain(supportMessage);
    expect(controls.document.getElementById('linkEmailWarning')?.style.display).toBe('block');
    controls.openLinkEmailModal();
    controls.expectDisabled(true);
    await controls.sendLinkVerification();
    expect(controls.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('only enables reconciliation-blocked controls after a new authoritative false status', async () => {
    const controls = loadControls();
    controls.fetchMock.mockResolvedValueOnce(response(emailStatus({ reconciliation_required: true, message: supportMessage })));
    await controls.loadLinkedEmails();
    controls.fetchMock.mockRejectedValueOnce(new Error('Offline'));
    await controls.loadLinkedEmails();
    controls.expectDisabled(true);
    expect(controls.document.getElementById('linkedEmailStatusMessage')?.textContent).toContain(supportMessage);

    const pending = deferredResponse();
    controls.fetchMock.mockReturnValueOnce(pending.promise);
    const load = controls.loadLinkedEmails();
    controls.expectDisabled(true);
    pending.resolve(response(emailStatus()));
    await load;
    controls.expectDisabled(false);
    expect(controls.document.getElementById('linkedEmailStatus')?.style.display).toBe('none');
  });

  it('ignores an older clear status that arrives after a reconciliation status', async () => {
    const controls = loadControls();
    const stale = deferredResponse();
    controls.fetchMock.mockReturnValueOnce(stale.promise);
    const staleLoad = controls.loadLinkedEmails();
    controls.fetchMock.mockResolvedValueOnce(response(emailStatus({ reconciliation_required: true, message: supportMessage })));
    await controls.loadLinkedEmails();
    stale.resolve(response(emailStatus()));
    await staleLoad;

    controls.expectDisabled(true);
    expect(controls.document.getElementById('linkedEmailStatusMessage')?.textContent).toContain(supportMessage);
  });

  it.each(['primary', 'link'] as const)('blocks retries after an ambiguous %s transport failure until status can be loaded', async (mutation) => {
    const controls = loadControls();
    await controls.loadReady();
    controls.enterEmail();
    controls.fetchMock.mockRejectedValueOnce(new Error('Connection closed before response'));
    if (mutation === 'primary') await controls.setPrimaryEmail('alias@example.test');
    else await controls.sendLinkVerification();

    controls.expectDisabled(true);
    expect(controls.document.getElementById('linkedEmailStatusMessage')?.textContent).toContain('Unable to confirm your email change');
    expect(controls.showToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    await controls.loadReady();
  });

  it('prevents concurrent link and primary mutations and waits for a fresh status after success', async () => {
    const controls = loadControls();
    await controls.loadReady();
    controls.enterEmail();
    const mutation = deferredResponse();
    const reload = deferredResponse();
    controls.fetchMock.mockReturnValueOnce(mutation.promise).mockReturnValueOnce(reload.promise);
    const save = controls.setPrimaryEmail('alias@example.test');
    controls.expectDisabled(true);
    await controls.sendLinkVerification();
    await controls.setPrimaryEmail('alias@example.test');
    expect(controls.fetchMock).toHaveBeenCalledTimes(2);

    mutation.resolve(response({ success: true }));
    await vi.waitFor(() => expect(controls.fetchMock).toHaveBeenCalledTimes(3));
    controls.expectDisabled(true);
    reload.resolve(response(emailStatus({ primary_email: 'alias@example.test', aliases: [{ email: 'primary@example.test' }] })));
    await save;
    controls.expectDisabled(false);
  });

  it.each([
    { data: { error: 'status_unavailable', message: 'Contact support to check email status.' }, status: 503 },
    { data: emailStatus({ reconciliation_required: undefined }), status: 200 },
  ])('fails closed when status is unavailable or lacks the reconciliation flag', async ({ data, status }) => {
    const controls = loadControls();
    controls.fetchMock.mockResolvedValueOnce(response(data, status));
    await controls.loadLinkedEmails();

    controls.expectDisabled(true);
    expect(controls.document.getElementById('linkedEmailStatus')?.style.display).toBe('block');
  });

  it('keeps a confirmed provider rejection retryable and prefers the support message', async () => {
    const controls = loadControls();
    await controls.loadReady();
    controls.fetchMock.mockResolvedValueOnce(response({
      error: 'provider_rejected',
      message: 'The provider rejected this address. Contact support if this continues.',
      reconciliation_required: false,
    }, 409));
    await controls.setPrimaryEmail('alias@example.test');

    controls.expectDisabled(false);
    expect(controls.showToast).toHaveBeenLastCalledWith('The provider rejected this address. Contact support if this continues.', 'error');
  });
});
