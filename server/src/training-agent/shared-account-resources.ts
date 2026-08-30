import type { CreativeState } from './types.js';

const SHARED_TRAINING_ACCOUNT_IDS = new Set(['acc_luma_shared']);
const sharedCreatives = new Map<string, Map<string, CreativeState>>();

export function isSharedTrainingAccount(accountId: string | undefined): accountId is string {
  return typeof accountId === 'string' && SHARED_TRAINING_ACCOUNT_IDS.has(accountId);
}

export function listSharedAccountCreatives(accountId: string | undefined): CreativeState[] {
  if (!isSharedTrainingAccount(accountId)) return [];
  return [...(sharedCreatives.get(accountId)?.values() ?? [])];
}

export function getSharedAccountCreative(
  accountId: string | undefined,
  creativeId: string,
): CreativeState | undefined {
  if (!isSharedTrainingAccount(accountId)) return undefined;
  return sharedCreatives.get(accountId)?.get(creativeId);
}

export function upsertSharedAccountCreative(accountId: string, creative: CreativeState): void {
  if (!isSharedTrainingAccount(accountId)) return;
  let creatives = sharedCreatives.get(accountId);
  if (!creatives) {
    creatives = new Map();
    sharedCreatives.set(accountId, creatives);
  }
  creatives.set(creative.creativeId, creative);
}

export function removeSharedAccountCreative(accountId: string | undefined, creativeId: string): void {
  if (!isSharedTrainingAccount(accountId)) return;
  sharedCreatives.get(accountId)?.delete(creativeId);
}

export function clearSharedAccountResources(): void {
  sharedCreatives.clear();
}
