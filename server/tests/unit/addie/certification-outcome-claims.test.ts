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

describe('receipt-bound certification claims', () => {
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
    expect(enforceOutcomeClaims('Module B2 is complete.', []).reason).toBeTruthy();
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
    "The credential's yours.", 'Your Foundations certificate is ready to download.', 'Your certification has been awarded.',
    'B2 is completed, so do not forget to practice.', 'B2 is completed but not yet reflected in your profile.',
    'B2 is completed when you are ready to move on.',
    'After that answer you have completed B2.', 'Your mastery of B2 has been demonstrated.', 'You have mastered B2.',
    'B2 is locked in.', 'B2 is in the books.', "You're through B2.",
    'We finished B2.', 'Congratulations, you passed B2!',
    'Your AdCP Practitioner credential is earned.', 'You are now certified!',
  ])('replaces an unconfirmed claim: %s', text => {
    expect(enforceCertificationClaims(text, []).text).toBe(UNCONFIRMED_CERTIFICATION);
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
    'You completed the exercise and this module is complete.',
    'You completed the exercise, so you have mastered it.',
  ])('does not let a teaching subtask authorize another conclusion: %s', text => {
    expect(enforceCertificationClaims(text, [], 'B2 certification').reason).toBeTruthy();
  });

  it.each([
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
