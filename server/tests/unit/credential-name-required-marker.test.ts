/**
 * Tests for the NAME_REQUIRED marker used by issueCertifierBadge and consumed
 * by Sage's prompt rule (`Credential name recovery` in buildCertificationContext).
 *
 * Three load-bearing sites have to agree on this string:
 *   1. The sentinel `issueCertifierBadge` returns
 *   2. The warning line `checkAndFormatCredentials` emits when the gate fires
 *   3. The Sage prompt rule that tells her how to recover
 *
 * If any drifts, Sage either loops back into the gate without recovering or
 * pastes the literal marker into the learner-facing reply. Both have user-
 * visible regressions (escalation #382 if the gate silently no-ops; ugly UX
 * if Sage echoes the marker). This file keeps them in sync.
 */

import { describe, it, expect } from 'vitest';
import { NAME_REQUIRED_MARKER } from '../../src/addie/mcp/certification-tools.js';

describe('NAME_REQUIRED marker', () => {
  it('is the literal string Sage pattern-matches', () => {
    expect(NAME_REQUIRED_MARKER).toBe('NAME_REQUIRED');
  });

  it('contains no whitespace or markdown so substring match never fails on rendering', () => {
    expect(NAME_REQUIRED_MARKER.trim()).toBe(NAME_REQUIRED_MARKER);
    expect(NAME_REQUIRED_MARKER).not.toMatch(/[\s*`]/);
  });
});
