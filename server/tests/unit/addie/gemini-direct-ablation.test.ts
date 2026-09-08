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
    expect(geminiDirectReceiptClaimCheck('Done—ticket 999 is live.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I raised the tracker item successfully.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('All set.', 'none').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('I created issue #999.', 'prior_turn_github_success').unverifiedClaim).toBe(true);
    expect(geminiDirectReceiptClaimCheck('Created issue #4242 at https://github.example.invalid/synthetic/repo/issues/4242.', 'current_turn_github_success')).toEqual({ exactPositive: true, unverifiedClaim: false });
    expect(geminiDirectReceiptClaimCheck('Created issue #999.', 'current_turn_github_success').exactPositive).toBe(false);
  });
});
