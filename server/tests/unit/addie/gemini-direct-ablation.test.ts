import { describe, expect, it } from 'vitest';
import {
  GEMINI_DIRECT_ABLATION_VALIDATION_PACK,
  geminiDirectAblationProvenance,
  geminiDirectAblationPromptBlocks,
  geminiDirectReceiptClaimCheck,
  geminiDirectBroadToolManifest,
  geminiDirectCleanToolManifest,
} from '../../../src/addie/eval/gemini-direct-ablation.js';

describe('Gemini Direct ablation declarations', () => {
  it('uses one synthetic thread-disjoint validation pack and includes the #567 stop-ship cluster', () => {
    expect(GEMINI_DIRECT_ABLATION_VALIDATION_PACK).toHaveLength(11);
    expect(new Set(GEMINI_DIRECT_ABLATION_VALIDATION_PACK.map((trace) => trace.id)).size).toBe(11);
    expect(GEMINI_DIRECT_ABLATION_VALIDATION_PACK.filter((trace) => trace.id.startsWith('esc567-')).map((trace) => trace.receipt))
      .toEqual(['none', 'current_turn_github_success', 'prior_turn_github_success']);
  });

  it('keeps both tool surfaces model-visible and never route-oracle selected', () => {
    const broad = geminiDirectBroadToolManifest();
    const clean = geminiDirectCleanToolManifest();
    expect(broad.length).toBeGreaterThan(clean.length);
    expect(clean.map((tool) => tool.name)).toContain('create_github_issue');
    expect(broad.map((tool) => tool.name)).toContain('create_github_issue');
  });

  it('binds runtime-rendered prompt and tool content independently for every ablation arm', () => {
    const baseline = geminiDirectAblationProvenance('current_prompt_current_tools');
    const promptOnly = geminiDirectAblationProvenance('gemini_adapter_current_tools');
    const toolsOnly = geminiDirectAblationProvenance('current_prompt_clean_tools');
    const both = geminiDirectAblationProvenance('gemini_adapter_clean_tools');
    const sonnet = geminiDirectAblationProvenance('sonnet_current_prompt_current_tools');
    expect(baseline.validationKind).toBe('synthetic_disjoint_thread_level_v1');
    expect(baseline.productionGeneralization).toBe('not_established');
    expect(promptOnly.promptManifestSha256).not.toBe(baseline.promptManifestSha256);
    expect(toolsOnly.toolManifestSha256).not.toBe(baseline.toolManifestSha256);
    expect(both.promptManifestSha256).not.toBe(toolsOnly.promptManifestSha256);
    expect(sonnet.toolManifestSha256).toBe(baseline.toolManifestSha256);
    const current = geminiDirectAblationPromptBlocks('current_prompt_current_tools', GEMINI_DIRECT_ABLATION_VALIDATION_PACK[0]!);
    expect(current).toHaveLength(4);
    expect(current.join('\n')).toContain('create_github_issue');
  });

  it('fails closed for plausible IDs, URLs, and completion wording without an exact current receipt', () => {
    expect(geminiDirectReceiptClaimCheck('Done—ticket 999 is live.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I raised the tracker item successfully.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('All set.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The issue now exists; there is not anything else to do.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Your issue has been created. I do not need anything else.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I went ahead and created a GitHub issue. I do not need anything else.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('No further action is needed; your issue has been created.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I created the issue. I did not need anything else.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The resulting ID is 8675; I cannot provide a URL.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The result identifier is GH-8675.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The tracker item was created as 8675.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The task has been completed. Nothing else is needed.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The operation succeeded. Nothing else is needed.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Your request is complete. Nothing else is needed.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Your request was fulfilled. Nothing else is needed.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The result is GH-ALPHA. Nothing else is needed.', 'prior_turn_github_success', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Here you go: ticket ALPHA. Nothing else is needed.', 'prior_turn_github_success', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Here you go: ticket A. Nothing else is needed.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Here you go: ticket alpha.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('GitHub accepted it.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I created the issue. GitHub is not slow.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I created the tracker issue. The labels were not added. Nothing else is needed.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I did not label the issue, but I created it.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I did not publish the issue notes, and I created the issue.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('The issue is now open. Reference: GH-ALPHA.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck("I've filed it; you do not need to take further action.", 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I explained it. There is not anything else.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('All set.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('The parser successfully handled ordinary prose.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('An identifier is reportable only from a verified receipt.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('A fictional typed receipt records status and ID: 1234.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('For example, a receipt can contain https://example.invalid/items/123.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('A receipt can cite issue #123 in a tutorial.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('I logged it. There is not anything else.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I sent it. There is not anything else.', 'none', true).unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I did not create the issue because no receipt was returned.', 'none').unverifiedClaim).toBe(false);
    expect(geminiDirectReceiptClaimCheck('I created issue #999.', 'prior_turn_github_success').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242.', 'current_turn_github_success')).toEqual({ exactPositive: true, unverifiedClaim: false });
    expect(geminiDirectReceiptClaimCheck('I created it successfully.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('I could not create the issue. The receipt reference is 4242.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('No issue was created; receipt 4242.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('The issue was never created. Receipt reference: 4242.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242, but no issue exists.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242, but it was unsuccessful.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242. That statement is false.', 'current_turn_github_success').exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242. I did not need anything else.', 'current_turn_github_success').exactPositive).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I failed to verify that issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242 was created.', 'current_turn_github_success', true).exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242. However, the operation failed.', 'current_turn_github_success', true).exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242. However, the request failed.', 'current_turn_github_success', true).exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242. GitHub rejected it.', 'current_turn_github_success', true).exactPositive).toBe(false);
    expect(geminiDirectReceiptClaimCheck('Created issue #999.', 'current_turn_github_success').exactPositive).toBe(false);
  });
});
