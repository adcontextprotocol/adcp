import { describe, expect, it } from 'vitest';
import { enforceOutcomeClaims, outcomeClaimContext, UNCONFIRMED_CERTIFICATION } from '../../../src/addie/outcome-claims.js';
import type { ToolExecution } from '../../../src/addie/model-providers/tool-orchestration.js';

function execution(tool_name: string, result: string, is_error = false): ToolExecution {
  return { tool_name, result, is_error, parameters: {}, duration_ms: 1 };
}
// These fixtures take place in a teaching conversation.
function enforceCertificationClaims(text: string, executions: readonly ToolExecution[], context = 'B2 certification') {
  return enforceOutcomeClaims(text, executions, context);
}
const completed = execution('complete_certification_module', 'Module B2 completed! The learner has demonstrated mastery of all learning objectives.');
const awarded = { ...completed, result: `${completed.result}\n**Credential earned: AdCP Practitioner!**` };
const shareUrl = 'https://credsverse.com/credentials/abc-b2';
const issued = { ...awarded, result: `${awarded.result}\n- [View and share your credential](${shareUrl})` };

describe('receipt-bound certification claims', () => {
  it('preserves product discovery conclusions even with certification history', () => {
    const text = 'Your media buy is complete. This is guaranteed streaming audio inventory. We have finished the product comparison.';
    const result = enforceCertificationClaims(text, [execution('call_adcp_get_products', 'Products found.')]);
    expect(result).toEqual({ text, reason: null });
  });

  it('preserves B1 membership guidance and unrelated completion predicates', () => {
    const text = 'You completed the exercise; B1 requires an active member organization. You have mastered it. We can continue once membership is active.';
    expect(enforceCertificationClaims(text, [execution('start_certification_module', 'Membership required')]))
      .toEqual({ text, reason: null });
  });

  it('confirms the successful A3 module and Basics credential without contradictory copy', () => {
    const receipt = execution('complete_certification_module', `Module A3 completed! The learner has demonstrated mastery of all learning objectives.\n**Credential earned: AdCP Basics!**\n- [View and share your credential](${shareUrl})`);
    const text = 'Congratulations, you completed A3! You are now AdCP Basics certified! Your credential is ready to share.';
    const result = enforceCertificationClaims(text, [receipt], 'A3 certification');
    expect(result.reason).toBeNull();
    expect(result.text).toContain('A3 is recorded as complete.');
    expect(result.text).toContain('AdCP Basics');
    expect(result.text).toContain(shareUrl);
    expect(result.text).not.toContain("haven't confirmed");
  });

  it('binds module outcomes to their clause and preserves the next module guidance', () => {
    for (const text of ['B2 is complete, but B3 requires membership.', 'B2 is complete and B3 requires membership.']) {
      const result = enforceCertificationClaims(text, [completed]);
      expect(result.reason).toBeNull();
      expect(result.text).toContain('B2 is recorded as complete.');
      expect(result.text).toContain('B3 requires membership.');
    }
  });

  it.each([
    'You completed the exercise and module B1 requires membership.',
    'You completed the exercise and your credential requires membership.',
    'You completed the registration for module B1.',
    'I finished explaining your certification options.',
    'You earned access to the B1 certification course.',
  ])('does not attach an unrelated predicate to certification nouns: %s', text => {
    expect(enforceCertificationClaims(text, [])).toEqual({ text, reason: null });
  });

  it('does not add module completions to a credential-only claim', () => {
    const result = enforceCertificationClaims('You earned the AdCP Practitioner credential.', [issued]);
    expect(result.reason).toBeNull();
    expect(result.text).not.toContain('B2');
    expect(result.text).toContain(shareUrl);
  });
  it.each(['Q4', 'H1', 'H2', 'V2', 'P1', 'S3', 'b2'])(
    'preserves ordinary identifiers outside a teaching conversation: %s', id => {
      const text = `Your ${id} migration is complete.`;
      const context = outcomeClaimContext([`How is the ${id} migration?`]);
      expect(enforceOutcomeClaims(text, [], context).text).toBe(text);
    },
  );

  it.each([
    '## Active certification modules\n- B2 (in progress)',
    '### Certification\nCurrently working on: B2 (in progress, started 1 days ago).',
  ])('uses active teaching facts without treating them as completion receipts', requestContext => {
    const context = outcomeClaimContext(['How did I do?'], requestContext);
    expect(enforceOutcomeClaims('b2 is concluded.', [], context).reason).toBeTruthy();
  });

  it('requires receipts for explicit module claims even without prior context', () => {
    for (const text of ['Module B2 is complete.', 'You passed the B2 module.', 'You have completed your B2 module.']) {
      expect(enforceOutcomeClaims(text, []).reason).toBeTruthy();
    }
  });

  it('preserves outcome-like strings inside code and inline JSON', () => {
    for (const text of ['```json\n{"description":"You earned your certificate."}\n```', '`{"description":"Module B2 is complete."}`']) {
      expect(enforceOutcomeClaims(text, [])).toEqual({ text, reason: null });
    }
  });

  it('preserves Markdown boundaries between rewritten prose and payloads', () => {
    const json = '```json\n{"x":1}\n```';
    expect(enforceOutcomeClaims(`Module B2 is complete.\n\n${json}`, []).text)
      .toBe(`${UNCONFIRMED_CERTIFICATION}\n\n${json}`);
  });

  it.each(['The get_products module needs a tutorial.', 'Update the reporting module.', 'The S3 migration uses v2.'])(
    'does not infer certification from software context: %s', context => {
      const text = "You've completed the tutorial.";
      expect(enforceOutcomeClaims(text, [], context).text).toBe(text);
      expect(enforceOutcomeClaims('You are done.', [], context).text).toBe('You are done.');
      for (const conclusion of ['The reporting module is complete.', 'The get_products module is complete.']) {
        expect(enforceOutcomeClaims(conclusion, [], context).text).toBe(conclusion);
      }
    },
  );

  it.each([
    'B2 is complete.', 'B2 is concluded.', 'B2 is done.', 'B2 mastery is confirmed.',
    'You passed the B2 module.', 'You have completed your B2 module.',
    'You passed your capstone.', 'You are officially done with module B2.',
    "The credential's yours.", 'Your Foundations certificate is ready to download.', 'Your certification has been awarded.',
    'B2 is completed, so do not forget to practice.', 'B2 is completed but not yet reflected in your profile.',
    'B2 is completed when you are ready to move on.',
    'After that answer you have completed B2.', 'Your mastery of B2 has been demonstrated.', 'You have mastered B2.',
    'B2 is locked in.', 'B2 is in the books.', "You're through B2.",
    'We finished B2.', 'Congratulations, you passed B2!',
    'Your AdCP Practitioner credential is earned.', 'You are now certified!',
  ])('replaces an unconfirmed claim: %s', text => {
    expect(enforceCertificationClaims(text, []).text).toContain(UNCONFIRMED_CERTIFICATION);
  });

  it('blocks rejected completion, then another exchange with no retry', () => {
    const rejection = execution('complete_certification_module', 'NOT COMPLETED — module B2 is not recorded as complete. Only 3 of 4 exchanges detected.');
    expect(enforceCertificationClaims('B2 is concluded.', [rejection]).reason).toBeTruthy();
    const followup = enforceCertificationClaims('That concludes this module. Why does product discovery precede buying?', [], rejection.result);
    expect(followup.text).toContain(UNCONFIRMED_CERTIFICATION);
    expect(followup.text).toContain('Why does product discovery precede buying?');
    expect(followup.text).not.toContain('That concludes');
  });

  it('never treats historical assistant or user assertions as persisted evidence', () => {
    expect(enforceCertificationClaims('B2 is complete.', [], 'Addie: Module B2 completed! User: B2 is complete.').reason).toBeTruthy();
  });

  it('requires the exact module, successful persistence receipt, and trusted tool', () => {
    expect(enforceCertificationClaims('B2 is complete.', [completed]).reason).toBeNull();
    expect(enforceCertificationClaims('B3 is complete.', [completed]).reason).toBeTruthy();
    expect(enforceCertificationClaims('B2 and B3 are complete.', [completed]).reason).toBeTruthy();
    expect(enforceCertificationClaims('B2 is complete.', [{ ...completed, is_error: true }]).reason).toBeTruthy();
    expect(enforceCertificationClaims('B2 is complete.', [{ ...completed, tool_name: 'search_docs' }]).reason).toBeTruthy();
    expect(enforceCertificationClaims('B2 is complete.', [execution('complete_certification_module', 'NOT COMPLETED\nModule B2 completed!')]).reason).toBeTruthy();
  });

  it('accepts authoritative progress and test-out state', () => {
    const progress = execution('get_learner_progress', '# Your certification progress\n\n## Module details\n- B2: completed\n- B3: in progress');
    expect(enforceCertificationClaims('B2 is complete.', [progress]).reason).toBeNull();
    expect(enforceCertificationClaims('B3 is complete.', [progress]).reason).toBeTruthy();
    const testout = execution('test_out_modules', 'Marked 1 module(s) as tested out:\n\n- B2: tested out\n\nAssessment notes: Module B3 completed!');
    expect(enforceCertificationClaims('B2 is complete.', [testout]).reason).toBeNull();
    expect(enforceCertificationClaims('B3 is complete.', [testout]).reason).toBeTruthy();
  });

  it('distinguishes passing an attempt from persisting the module', () => {
    const passed = execution('complete_certification_exam', '# Congratulations! The learner passed the capstone!');
    expect(enforceCertificationClaims('S3 is complete.', [passed]).reason).toBeTruthy();
    expect(enforceCertificationClaims('S3 is complete.', [{ ...passed, result: `${passed.result}\nModule S3 completed!` }]).reason).toBeNull();
  });

  it('requires independent credential award and external issuance receipts', () => {
    const awarded = { ...completed, result: `${completed.result}\n**Credential earned: AdCP Practitioner!**` };
    expect(enforceCertificationClaims('You earned the AdCP Practitioner credential.', [completed]).reason).toBeTruthy();
    expect(enforceCertificationClaims('You earned the AdCP Practitioner credential.', [awarded]).reason).toBeNull();
    const extra = enforceCertificationClaims('You earned the AdCP Practitioner and Foundations certification.', [awarded]);
    expect(extra.text).not.toContain('Foundations');
    expect(extra.text).toContain('Credential earned: AdCP Practitioner.');
    expect(enforceCertificationClaims('B3 is completed and you earned the AdCP Practitioner credential.', [awarded]).reason).toBeTruthy();
    expect(enforceCertificationClaims('Your earned AdCP Practitioner certificate is ready to download.', [awarded]).reason).toBeTruthy();
    const issued = { ...awarded, result: `${awarded.result}\n- [View and share your credential](https://credsverse.com/credentials/example-id)` };
    expect(enforceCertificationClaims('Your earned AdCP Practitioner certificate is ready to download.', [issued]).reason).toBeNull();
  });

  it.each([
    'Congratulations, you earned your certificate!', 'You earned a badge.',
    "The credential's yours.", 'Your certification has been awarded.', 'You are now certified!',
  ])('renders an unambiguous persisted credential for generic wording: %s', text => {
    const result = enforceCertificationClaims(text, [awarded]);
    expect(result.reason).toBeNull();
    expect(result.text).toContain('Credential earned: AdCP Practitioner.');
    expect(result.text).not.toContain('haven\'t confirmed');
    expect(result.text).not.toContain('credsverse.com');
    expect(enforceCertificationClaims(text, [completed]).reason).toBeTruthy();
  });

  it.each([
    'Your certificate has been issued.', 'Your certificate is ready to download.',
    `Your AdCP Practitioner certificate has been issued: [View and share](${shareUrl}).`,
    `You earned the [AdCP Practitioner credential](${shareUrl})!`,
    'Your AdCP Practitioner certificate has been issued: [View and share](https://example.com/untrusted).',
  ])('preserves only the receipt-owned credential link: %s', text => {
    const result = enforceCertificationClaims(text, [issued]);
    expect(result.reason).toBeNull();
    expect(result.text).toContain(`[View and share your credential](${shareUrl})`);
    expect(result.text).not.toContain('https://example.com');
    if (!text.startsWith('You earned')) expect(enforceCertificationClaims(text, [awarded]).reason).toBeTruthy();
  });

  it.each([
    'You earned the Advanced Specialist certificate.',
    'You earned your certificate and the Advanced Specialist certificate.',
    'Your certificate for Advanced Specialist has been issued.',
    'B3 is complete and you earned your certificate.',
  ])('does not let a generic receipt authorize another named outcome: %s', text => {
    expect(enforceCertificationClaims(text, [issued]).reason).toBeTruthy();
  });

  it('does not guess between multiple saved credentials or accept unsuccessful evidence', () => {
    const multiple = { ...awarded, result: `${awarded.result}\n**Credential earned: AdCP Specialist!**` };
    expect(enforceCertificationClaims('You earned your certificate.', [multiple]).reason).toBeTruthy();
    expect(enforceCertificationClaims('You earned your certificate.', [{ ...awarded, is_error: true }]).reason).toBeTruthy();
    expect(enforceCertificationClaims('You earned your certificate.', [{ ...awarded, tool_name: 'search_docs' }]).reason).toBeTruthy();
  });

  it.each([
    'https://credsverse.com.example.com/credentials/id',
    'https://credsverse.com/credentials/%2e%2e',
    'https://credsverse.com/credentials/.',
  ])('does not treat malformed receipt links as credential issuance: %s', url => {
    const invalid = { ...awarded, result: `${awarded.result}\n- [View and share your credential](${url})` };
    expect(enforceCertificationClaims('Your certificate has been issued.', [invalid]).reason).toBeTruthy();
  });

  it.each([
    'You completed the exercise and this module is complete.',
  ])('does not let a teaching subtask authorize another conclusion: %s', text => {
    expect(enforceCertificationClaims(text, [], 'B2 certification').reason).toBeTruthy();
  });

  it.each([
    'You completed the exercise, so you have mastered it.',
    'You earned it.',
    'The media buy was completed after the seller accepted the proposal.',
    'You are ready to try another exercise.', 'You are ready for B2.',
    'You have completed the exercise.', "You've completed the tutorial.", 'You have mastered this example.', 'Mastery comes from practice.', 'Complete B2 before starting B3.',
    'When your certificate is issued, you can share it.', 'Has your certificate been issued?',
  ])('preserves teaching inside certification context: %s', text => {
    expect(enforceCertificationClaims(text, [], 'B2 certification').text).toBe(text);
  });

  it.each([
    'B2 is not complete yet.', 'Once B2 is complete, we can move on.',
    'Have you completed B2?', 'Before we complete B2, try another example.',
    'Your explanation of targeting is clear. How would you apply it to this product?',
    'The media buy completed successfully.',
  ])('preserves teaching, questions, conditional guidance and ordinary actions: %s', text => {
    expect(enforceCertificationClaims(text, []).text).toBe(text);
  });
});
