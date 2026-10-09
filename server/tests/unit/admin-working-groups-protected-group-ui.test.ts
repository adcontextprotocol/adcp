import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// Regression for #7713: the Manage Committee modal always PUT the whole form,
// so saving the aao-admin group failed with the server's intentional 405.
// Its membership is edited through the audited grant/revoke endpoints and is
// already saved, so the modal must not submit settings or leaders at all.

const source = readFileSync(
  new URL('../../public/admin-working-groups.html', import.meta.url),
  'utf8',
);

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing section: ${start}`);
  return source.slice(startIndex, endIndex);
}

function loadModal() {
  const dom = new JSDOM(source);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  const closeModal = vi.fn();
  const loadGroups = vi.fn();
  const alertMock = vi.fn();

  const api = new Function(
    'document',
    'fetch',
    'closeModal',
    'loadGroups',
    'alert',
    `let editingGroup = null;
    let currentLeaders = [];
    let currentTopics = [];
    ${section('function updateMembersSectionVisibility()', '// Current leaders in the form')}
    ${section('async function saveGroup(event)', '// Show deactivate modal')}
    return {
      setEditing(group, leaders = []) { editingGroup = group; currentLeaders = leaders; },
      updateMembersSectionVisibility,
      saveGroup,
    };`,
  )(dom.window.document, fetchMock, closeModal, loadGroups, alertMock) as {
    setEditing: (group: Record<string, unknown> | null, leaders?: Array<{ user_id: string }>) => void;
    updateMembersSectionVisibility: () => void;
    saveGroup: (event: { preventDefault: () => void }) => Promise<void>;
  };

  const doc = dom.window.document;
  const fill = (group: { id: string; name: string; slug: string }) => {
    (doc.getElementById('groupId') as HTMLInputElement).value = group.id;
    (doc.getElementById('name') as HTMLInputElement).value = group.name;
    (doc.getElementById('slug') as HTMLInputElement).value = group.slug;
  };

  return { doc, fetchMock, closeModal, loadGroups, alertMock, fill, ...api };
}

const aaoAdminGroup = { id: 'wg_aao_admin', name: 'AAO Administration', slug: 'aao-admin' };
const regularGroup = { id: 'wg_protocol', name: 'Protocol Development', slug: 'protocol' };

describe('working group admin modal for the site-admin group (#7713)', () => {
  it('hides and disables settings and leaders for aao-admin and labels the button Done', () => {
    const { doc, setEditing, updateMembersSectionVisibility } = loadModal();
    setEditing(aaoAdminGroup);
    updateMembersSectionVisibility();

    const settings = doc.getElementById('groupSettingsSection') as HTMLElement;
    expect(settings.style.display).toBe('none');
    const controls = settings.querySelectorAll<HTMLInputElement>('input, select, textarea, button');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control.disabled).toBe(true);
    expect((doc.getElementById('leaderSearch') as HTMLInputElement).disabled).toBe(true);

    expect((doc.getElementById('protectedGroupNotice') as HTMLElement).style.display).toBe('block');
    expect((doc.getElementById('membersSection') as HTMLElement).style.display).toBe('block');
    expect((doc.getElementById('memberSearch') as HTMLInputElement).disabled).toBe(false);
    expect(doc.getElementById('saveBtn')?.textContent).toBe('Done');
  });

  it('does not PUT settings or leaders when closing the aao-admin modal', async () => {
    const { fetchMock, closeModal, loadGroups, alertMock, fill, setEditing, saveGroup } = loadModal();
    fill(aaoAdminGroup);
    setEditing(aaoAdminGroup, [{ user_id: 'user_leader' }]);

    await saveGroup({ preventDefault: () => {} });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(closeModal).toHaveBeenCalledOnce();
    expect(loadGroups).toHaveBeenCalledOnce();
  });

  it('restores the editable form and generic PUT for other groups', async () => {
    const { doc, fetchMock, fill, setEditing, updateMembersSectionVisibility, saveGroup } = loadModal();
    setEditing(aaoAdminGroup);
    updateMembersSectionVisibility();

    fill(regularGroup);
    setEditing(regularGroup, [{ user_id: 'user_leader' }]);
    updateMembersSectionVisibility();

    const settings = doc.getElementById('groupSettingsSection') as HTMLElement;
    expect(settings.style.display).toBe('');
    expect((doc.getElementById('name') as HTMLInputElement).disabled).toBe(false);
    expect((doc.getElementById('leaderSearch') as HTMLInputElement).disabled).toBe(false);
    expect((doc.getElementById('protectedGroupNotice') as HTMLElement).style.display).toBe('none');
    expect(doc.getElementById('saveBtn')?.textContent).toBe('Save');

    await saveGroup({ preventDefault: () => {} });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/working-groups/wg_protocol');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body).leader_user_ids).toEqual(['user_leader']);
  });
});
