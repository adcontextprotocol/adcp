// Types for lib/mock-seller.mjs (an in-process stand-in for a seller agent).
import type { AdcpServer } from './server.mjs';
export interface MockSeller {
  transport: { call(task: string, request: object): Promise<any>; subscribe(fn: (record: any) => void): () => void };
  /** The seller's back office: changes it makes to a live buy. */
  ops: {
    creatorUnavailable(mediaBuyId: string, purchaseIndex: number, days: number): unknown;
    rogueShift(mediaBuyId: string, purchaseIndex: number, days: number): unknown;
    deliverableMissed(mediaBuyId: string, purchaseIndex: number): unknown;
  };
  /** The extension versions it declares, oldest seller-adjustable-terms first. */
  supported: { uri: string; version: string; digest: string }[];
  /** The sales agent's server (lib/server.mjs): its handlers and declarations. */
  server: AdcpServer;
}
/** The buying layers the creator network lists in its capabilities by default. */
export const CREATOR_NETWORK_MODULES: string[];
export function createCreatorNetworkSeller(options?: { now?: () => number; ignoreUnderstood?: boolean; modules?: string[] }): MockSeller;
