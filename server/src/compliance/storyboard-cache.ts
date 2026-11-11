/**
 * Process-wide cache over the SDK's compliance storyboard loader.
 *
 * `getComplianceStoryboardById` parses every storyboard YAML in the selected
 * bundle on each call (about 1.3s of CPU for a 3.3 bundle) just to return one.
 * Compliance bundles are immutable per version and directory, so each bundle is
 * parsed once per process and looked up by ID afterwards. Callers receive a
 * clone, so nothing they do can change the cached storyboards.
 */
import { listAllComplianceStoryboards, type Storyboard } from '@adcp/sdk/testing';

type ResolveOptions = NonNullable<Parameters<typeof listAllComplianceStoryboards>[0]>;

const bundles = new Map<string, Map<string, Storyboard>>();

/** Only these fields select a bundle; callers may pass richer run options. */
function bundleKey(options: ResolveOptions): string {
  return JSON.stringify([
    options.version ?? null,
    options.complianceDir ?? null,
    options.schemaRoot ?? null,
    options.hostedStableLineAlias ?? null,
  ]);
}

export function getCachedComplianceStoryboardById(id: string, options: ResolveOptions = {}): Storyboard | undefined {
  const key = bundleKey(options);
  let byId = bundles.get(key);
  if (!byId) {
    // A missing or unreadable bundle throws and is not cached.
    byId = new Map(listAllComplianceStoryboards(options).map(storyboard => [storyboard.id, storyboard]));
    bundles.set(key, byId);
  }
  const storyboard = byId.get(id);
  return storyboard === undefined ? undefined : structuredClone(storyboard);
}

/** For tests that build bundles into a reused directory. */
export function clearComplianceStoryboardCache(): void {
  bundles.clear();
}
