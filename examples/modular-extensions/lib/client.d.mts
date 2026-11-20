// Types for lib/client.mjs. Task types are a hand-written subset of the core
// schemas: json-schema-to-typescript collapses the allOf-based task schemas
// (README "Design issues" 10); sdk-js already carries transforms for that.
//
// The task types take the form of the data at each hook as a type parameter. The default is the
// wire form: extension data in envelopes { uri, digest, data }. An app's generated binding
// (adcp-sdk/types.ts, written by scripts/adcp-sdk.mjs) fills the parameter with its own types, so
// extension data is a plain attribute: Proposal<Forms>['commercial_terms']['makegood_units'].
import type { CommercialTerms, ContributedTask, ExtensionEntry } from '../packages/core/src/index.ts';

export interface ExtensionRef { uri: string; digest: string }

/** What sits at each hook the core declares. A generated binding fills these with plain attributes. */
export interface HookForms {
  /** The commercial_terms object (buying/commitment's extension point). */
  commercial_terms: object;
  /** What a media buy adds at buying/execution's extension point media_buy_state. */
  media_buy_state: object;
  /** One pricing option (buying/pricing's pricing_model union and pricing_option extension point). */
  pricing: object;
}

/** A pricing option with a core pricing model (core/canonical-pricing-option.json, as far as this example reads it). */
export interface CorePricingOption {
  pricing_option_id: string;
  pricing_model: 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'revenue_share' | 'flat_rate' | 'time';
  currency: string;
  fixed_price?: number;
  floor_price?: number;
  min_spend_per_package?: number;
  parameters?: object;
  price_breakdown?: object;
}

/** A pricing option on the wire: a core model, or an extension branch id with its body in extension_model. */
export type WirePricingOption = Omit<CorePricingOption, 'pricing_model'> & {
  pricing_model: string;
  extension_model?: ExtensionEntry;
  extensions?: ExtensionEntry[];
} & Record<string, unknown>;

/** The wire form: extension data in envelopes. */
export interface WireForms {
  commercial_terms: CommercialTerms;
  media_buy_state: { extensions_state?: ExtensionEntry[] };
  pricing: WirePricingOption;
}

export interface Proposal<F extends HookForms = WireForms> {
  proposal_id: string;
  proposal_kind: 'new_media_buy' | 'media_buy_update' | 'media_buy_cancellation';
  proposal_status: 'draft' | 'committed' | 'accepted';
  name: string;
  expires_at?: string;
  hold_policy?: { available: boolean; min_duration?: string; max_duration?: string };
  hold_placed_at?: string;
  commercial_terms: F['commercial_terms'];
  terms_digest: string;
  accepted_at?: string;
  media_buy_id?: string;
}

/** A compact product from request_proposals (core/canonical-product.json), as far as this example reads it. */
export interface CanonicalProduct<F extends HookForms = WireForms> {
  product_id: string;
  name: string;
  channels?: string[];
  pricing_options?: F['pricing'][];
}

/** A product from get_products (core/product.json), as far as this example reads it (core/product.json has far more). */
export interface Product<F extends HookForms = WireForms> {
  product_id: string;
  name: string;
  channels?: string[];
  pricing_options: F['pricing'][];
}

export interface MediaBuyPackage {
  package_id: string;
  product_id?: string;
  budget?: number;
  start_time?: string;
  end_time?: string;
  canceled?: boolean;
}

/** A media buy (get_media_buys), as far as this example reads it. F['media_buy_state'] is the readback written by accepted extensions. */
export type MediaBuy<F extends HookForms = WireForms> = {
  media_buy_id: string;
  status: string;
  revision: number;
  total_budget: number;
  start_time?: string;
  end_time?: string;
  accepted_proposal?: Proposal<F>;
  packages: MediaBuyPackage[];
} & F['media_buy_state'];

/** request_proposals response. */
export interface RequestProposalsResponse<F extends HookForms = WireForms> {
  outcome: 'proposed' | 'products_available' | 'rejected';
  status?: 'completed' | 'submitted';
  proposals?: Proposal<F>[];
  products?: CanonicalProduct<F>[];
  reason?: string;
}

/** Requests, as far as this example sends them. understood_extensions is added by the SDK. */
export interface RequestProposalsRequest { idempotency_key: string; brief: string; brand?: { domain: string }; account?: object; understood_extensions?: ExtensionRef[] }
export interface RefineProposalsRequest { idempotency_key: string; refinements: { proposal_id: string; action: 'finalize' | 'revise' | 'extend_hold' }[]; understood_extensions?: ExtensionRef[] }
export interface GetProductsRequest { buying_mode: 'brief' | 'wholesale' | 'refine'; brief?: string; brand?: { domain: string }; understood_extensions?: ExtensionRef[] }
export interface AcceptProposalRequest { idempotency_key: string; account: { account_id: string }; proposal_id: string; proposal_terms_digest: string; name?: string }

export interface AccountChange {
  change_id: string;
  resource: { type: string; account_id: string; resource_id?: string };
  action: string;
  origin: { kind: string };
  resource_revision?: number | string;
  changed_paths?: string[];
  reason?: string;
  summary?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: { code: string; path?: string; message: string }[];
  warnings: { code: string; path?: string; message: string }[];
  violations: { code: 'EXTENSION_DATA_VIOLATED'; path: string; uri: string; message: string }[];
  extensions: { path: string; point: string; branch?: string; side?: 'request' | 'response'; uri: string; digest: string; must_understand: boolean; status: 'understood' | 'ignored' | 'rejected' | 'dropped' }[];
  /** Array items dropped because their open-union branch is not understood (unknown_in_list: drop_option). */
  dropped: string[];
}

export class AdcpClientError extends Error {
  code: string;
  report?: ValidationReport;
}

/** A seller's declaration of one extension: hooks, capability fragment, and the tasks it serves. */
export interface DeclaredExtension extends ExtensionRef {
  points?: string[];
  capabilities?: object;
  /** Transport name (MCP tool / A2A skill) -> task id (<uri>#<task>). */
  tasks?: { name: string; task: string }[];
}

/** One module or buying layer in the seller's capabilities: its version and frozen digest. */
export interface ModuleVersion {
  version: string;
  digest: string;
}

/** The seller's `modules` map checked against this app's module versions (lib/modules.mjs). */
export interface ModuleCheck {
  ok: boolean;
  entries: { name: string; app: string | null; seller: string | null; status: 'same' | 'seller-newer' | 'seller-older' | 'not-offered' | 'not-used' | 'MODULE_MAJOR_MISMATCH' | 'MODULE_DIGEST_MISMATCH' }[];
  errors: { code: 'MODULE_MAJOR_MISMATCH' | 'MODULE_DIGEST_MISMATCH'; name: string; message: string }[];
}

export interface SellerCapabilities {
  declared_extensions?: DeclaredExtension[];
  /** The modules and buying layers the seller implements (proposed 3.4, optional). */
  modules?: Record<string, ModuleVersion>;
  /** modules checked against this app's lock; null when the seller lists none. */
  moduleCheck: ModuleCheck | null;
  negotiation: {
    usable: string[];
    sellerOnly: string[];
    versionSkew: string[];
    /** Task id -> the transport name the seller serves it under, for each usable uri@digest. */
    tasks: Record<string, { name: string; uri: string; digest: string }>;
  };
}

/** Runtime binding: an extension package enabled at run time (its generated module namespace). */
export interface ExtensionModule {
  EXTENSION_URI: string;
  EXTENSION_DIGEST: string;
  EXTENSION_MODULE_DIR: URL;
  tasks?: Record<string, ContributedTask<any, any>>;
}

/** Runtime binding: one typed method per task a module contributes (client.ext(module)). */
export type TaskMethods<M extends { tasks?: Record<string, ContributedTask<any, any>> }> = {
  [K in keyof NonNullable<M['tasks']>]: NonNullable<M['tasks']>[K] extends ContributedTask<infer Req, infer Res> ? (request: Req) => Promise<Res> : never;
};

/**
 * The wire-level SDK client. Apps use their generated binding's createClient() instead; this client,
 * with `extensions` modules and ext(), is the runtime binding, kept for runtime plug-ins (a host that
 * loads an extension by uri@digest at run time, such as the conformance runner).
 */
export interface AdcpClient<F extends HookForms = WireForms> {
  lastReport: ValidationReport | null;
  lastReports: ValidationReport[];
  sellerCapabilities: SellerCapabilities | null;
  lastTaskCall: { name: string; task: string } | null;
  capabilities(): Promise<SellerCapabilities>;
  /** Throws MODULE_NOT_OFFERED, MODULE_MAJOR_MISMATCH, or MODULE_DIGEST_MISMATCH when the seller's modules can't serve a core task. */
  requireModules(task: string): void;
  /** Call a contributed task under the transport name the seller declared; validates both directions. */
  callTask<Req, Res>(task: ContributedTask<Req, Res>, request: Req): Promise<Res>;
  /** Runtime binding: client.ext(module).<task>(request), the module's tasks as typed methods. A generated binding has client.<task>(request) instead. */
  ext<M extends ExtensionModule>(module: M): TaskMethods<M>;
  /** Discovery-time products and pricing options. Legacy get_products proposals (core/proposal.json, no commercial_terms) are not typed. */
  getProducts(request: GetProductsRequest): Promise<{ products?: Product<F>[] }>;
  /** Draft canonical proposals with commercial_terms and terms_digest (request_proposals). */
  requestProposals(request: RequestProposalsRequest): Promise<RequestProposalsResponse<F>>;
  refineProposals(request: RefineProposalsRequest): Promise<{ proposals: Proposal<F>[] }>;
  acceptProposal(request: { proposal: Proposal<F>; idempotency_key: string; account: { account_id: string }; name?: string }): Promise<{ media_buy_id: string; revision: number }>;
  getMediaBuys(request: { media_buy_ids: string[] }): Promise<{ media_buys: MediaBuy<F>[] }>;
  onChange(handler: (change: AccountChange) => void | Promise<void>): () => void;
}

export function createAdcpClient(options: {
  transport: { call(task: string, request: object): Promise<any>; subscribe(fn: (record: any) => void): () => void };
  /** Runtime binding: installed extension modules to enable at run time (each package's module namespace). */
  extensions?: ExtensionModule[];
  /** Or: an adcp.lock.json written by adcp-sdk. */
  lockfile?: string | URL;
  onViolation?: (violation: ValidationReport['violations'][number], payload: unknown) => void;
}): Promise<AdcpClient>;
