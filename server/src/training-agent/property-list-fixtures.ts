/**
 * Canned buyer property lists for compliance storyboards.
 *
 * The media-buy storyboards `inventory_list_targeting` and
 * `inventory_list_no_match` reference lists published by a fictional
 * governance agent (`governance.pinnacle-agency.example`) and rely on the
 * seller's test engine to resolve them, because a `.example` host can never be
 * dialed. The training agent resolves exactly these references in process,
 * before any network fetch. Any other reference is fetched from the buyer's
 * list agent. Contents mirror `inventory_targets` in
 * `static/compliance/source/test-kits/acme-outdoor.yaml`; a unit test keeps the
 * two in step.
 */

export interface FixtureListIdentifier {
  type: string;
  value: string;
}

export const STORYBOARD_LIST_AGENT_URL = 'https://governance.pinnacle-agency.example';

export const STORYBOARD_PROPERTY_LISTS: ReadonlyMap<string, readonly FixtureListIdentifier[]> = new Map([
  ['acme_outdoor_allowlist_v1', [
    { type: 'domain', value: 'outdoormagazine.example' },
    { type: 'domain', value: 'hikingtrails.example' },
    { type: 'domain', value: 'campinggear.example' },
    { type: 'domain', value: 'mountaineering.example' },
  ]],
  ['acme_outdoor_allowlist_v2', [
    { type: 'domain', value: 'outdoormagazine.example' },
    { type: 'domain', value: 'campinggear.example' },
  ]],
  ['acme_outdoor_no_match_v1', [
    { type: 'domain', value: 'never-sold-here.example' },
    { type: 'domain', value: 'also-not-indexed.example' },
  ]],
]);

export function isStoryboardListAgent(agentUrl: string): boolean {
  return agentUrl.replace(/\/+$/, '').toLowerCase() === STORYBOARD_LIST_AGENT_URL;
}

export function storyboardPropertyList(
  agentUrl: string,
  listId: string,
): readonly FixtureListIdentifier[] | undefined {
  return isStoryboardListAgent(agentUrl) ? STORYBOARD_PROPERTY_LISTS.get(listId) : undefined;
}
