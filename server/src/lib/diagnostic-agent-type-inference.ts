/**
 * Lightweight agent-type inference for the public discovery diagnostic
 * endpoints (`/api/discover/agent` in http.ts and the equivalent in
 * registry-api.ts). Uses LOOSE substring matching by design — these
 * endpoints serve as quick "what kind of agent is this URL" probes for
 * onboarding flows where the agent's tool names may not yet conform
 * exactly to the AdCP spec.
 *
 * For canonical, strict-match inference used by the registry crawler,
 * see `CapabilityDiscovery.inferAgentType` in `../capabilities.ts`. That
 * is the source of truth for stored agent type.
 *
 * Polarity correction: pre-#3540 this inference (in two duplicated
 * inline blocks) returned `'buying'` for agents exposing SALES_TOOLS-
 * adjacent tool names. That was the same inversion class fixed in PR
 * #3540 across the filter sites. PR #3774 closes the gap by extracting
 * a single helper, flipping the polarity to `'sales'`, and pinning the
 * matrix with this file's test.
 */

export type DiagnosticAgentType = 'sales' | 'creative' | 'signals' | 'unknown';

/**
 * Infer agent type from a list of tool names using loose substring matching.
 *
 * Priority: sales > signals > creative when an agent's tool names match
 * multiple buckets — sales wins because the rest of the registry surface
 * treats sell-side as the primary integration target.
 */
export function inferDiagnosticAgentType(
  toolNames: string[],
): DiagnosticAgentType {
  const lower = toolNames.map((n) => n.toLowerCase());

  // SALES_TOOLS-adjacent: agent EXPOSES sell-side surface (get_products,
  // create_media_buy, list_authorized_properties). Match `media_buy` and
  // `create_media` separately because some non-conformant agents publish
  // `create_media_purchase` etc.
  if (
    lower.some(
      (n) => n.includes('get_product') || n.includes('media_buy') || n.includes('create_media'),
    )
  ) {
    return 'sales';
  }
  if (lower.some((n) => n.includes('signal') || n.includes('audience'))) {
    return 'signals';
  }
  if (
    lower.some(
      (n) => n.includes('creative') || n.includes('format') || n.includes('preview'),
    )
  ) {
    return 'creative';
  }
  return 'unknown';
}
