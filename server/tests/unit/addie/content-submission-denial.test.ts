import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemberContext } from '../../../src/addie/member-context.js';
import { normalizeToolResult } from '../../../src/addie/tool-result-contract.js';

const proposeContentForUser = vi.hoisted(() => vi.fn());
vi.mock('../../../src/routes/content.js', () => ({ proposeContentForUser }));
import { createMemberToolHandlers } from '../../../src/addie/mcp/member-tools.js';

afterEach(() => vi.clearAllMocks());
const member = { workos_user: { workos_user_id: 'user_dayo', email: 'dayo@example.test' } } as MemberContext;

describe('content submission membership denial', () => {
  it.each(['MEMBERSHIP_REQUIRED', 'COMMITTEE_MEMBERSHIP_REQUIRED'])(
    'preserves actionable denial %s through tool normalization', async error_code => {
      const error = 'Publishing requires an eligible membership. Check https://agenticadvertising.org/dashboard/membership.';
      proposeContentForUser.mockResolvedValue({ success: false, error_code, error });
      const result = normalizeToolResult('propose_content', await createMemberToolHandlers(member).get('propose_content')!({ title: 'Campaign notes', content: 'A short draft.' }));
      expect(result).toMatchObject({
        status: 'access_denied',
        presentation: { telemetry: { operation: 'propose_content', error_code, error_category: 'authorization', retryable: false } },
      });
      expect(result.model_context).toContain(error);
      expect(result.presentation.user_summary).toContain('Content was not submitted.');
      expect(proposeContentForUser).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ status: 'pending_review' }));
    },
  );

  it('keeps successful proposals pending review', async () => {
    proposeContentForUser.mockResolvedValue({ success: true, status: 'pending_review' });
    const result = await createMemberToolHandlers(member).get('propose_content')!({ title: 'Campaign notes', content: 'A short draft.' });
    expect(normalizeToolResult('propose_content', result).status).toBe('ok');
    expect(result).toContain('Pending Review');
  });
});
