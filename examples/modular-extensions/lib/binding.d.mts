// Types for lib/binding.mjs, the runtime of a generated binding. The generated layer
// (adcp-sdk/types.ts) instantiates BoundClient and BoundServer with the app's own forms, tasks, and
// attributes, so extension data and contributed tasks are typed without casts in app code.
import type {
  AcceptProposalRequest,
  AdcpClient,
  GetProductsRequest,
  HookForms,
  MediaBuy,
  Product,
  Proposal,
  RefineProposalsRequest,
  RequestProposalsRequest,
  RequestProposalsResponse,
  SellerCapabilities,
  ValidationReport,
  AccountChange,
  ExtensionRef,
} from './client.mjs';
import type { SellerRejection } from './server.mjs';

/** One host of a hook in a message: a data path ('*' = every array item) and the hook's policy. */
export interface HookHost {
  readonly path: readonly string[];
  readonly kind: 'point' | 'union';
  readonly hook: string;
  readonly container?: string;
  readonly must_understand?: 'always' | 'flag' | 'never';
  readonly order?: 'uri';
  readonly discriminator?: string;
  readonly body?: string;
  readonly unknown_in_list?: string;
  readonly schemas: readonly { readonly id: string; readonly pointer: string }[];
  readonly properties: readonly string[];
}

/** One enabled extension, keyed by uri@digest; `attribute` is its key in adcp.config.json. */
export interface ExtensionBinding {
  readonly attribute: string;
  readonly name: string;
  readonly version: string;
  readonly uri: string;
  readonly digest: string;
  readonly bundle: string;
  readonly hooks: { readonly [hook: string]: { readonly definition: string } };
  readonly branches: { readonly [hook: string]: { readonly branch: string; readonly id: string; readonly definition: string } };
  readonly tasks: { readonly [task: string]: { readonly method: string; readonly id: string; readonly request: string; readonly response: string } };
}

/** The frozen binding a generated layer carries (adcp-sdk/bindings.ts). */
export interface Binding {
  readonly app: string;
  /** The core the layer was generated for: the whole bundle, or (an app that names its modules) the kernel layer and those modules. */
  readonly core: { readonly version: string; readonly bundle_digest?: string; readonly modules?: Readonly<Record<string, { readonly version: string; readonly digest: string }>> };
  readonly lockfile: URL;
  readonly bundles: URL;
  readonly extensions: readonly ExtensionBinding[];
  readonly layout: { readonly [message: string]: { readonly roots: readonly (readonly [readonly string[], string])[]; readonly negotiates?: boolean; readonly hosts: readonly HookHost[] } };
}

export interface BindingIssue {
  code: string;
  /** JSON pointer into the wire message */
  path: string;
  message: string;
}
export class BindingError extends Error {
  code: string;
  issues: BindingIssue[];
}

export const WIRE_STATE: unique symbol;
export function decode(message: unknown, hosts: readonly HookHost[], extensions: readonly ExtensionBinding[], what?: string): unknown;
export function encode(value: unknown, hosts: readonly HookHost[], extensions: readonly ExtensionBinding[], validate?: Validate, what?: string): unknown;
export function requireUnderstood(agreed: Set<string>, value: unknown, hosts: readonly HookHost[], extensions: readonly ExtensionBinding[]): BindingIssue[];
export type Validate = (binding: ExtensionBinding, definition: string, data: unknown) => { instancePath: string; message?: string }[];
export function bindingValidator(binding: Binding): Validate;
export function wireSchema(binding: Binding, message: string): object;
export function boundTermsDigest(binding: Binding, terms: unknown): string;

export interface ClientOptions {
  transport: { call(task: string, request: object): Promise<any>; subscribe(fn: (record: any) => void): () => void };
  onViolation?: (violation: ValidationReport['violations'][number], payload: unknown) => void;
}

/** The buyer client of a generated binding: core tasks with the app's forms. The generated Client adds one method per contributed task. */
export interface BoundClient<F extends HookForms> {
  /** The wire-level SDK client under this layer. */
  readonly wire: AdcpClient;
  readonly lastReport: ValidationReport | null;
  readonly lastReports: ValidationReport[];
  readonly sellerCapabilities: SellerCapabilities | null;
  readonly lastTaskCall: { name: string; task: string } | null;
  understoodExtensions(): ExtensionRef[];
  capabilities(): Promise<SellerCapabilities>;
  getProducts(request: GetProductsRequest): Promise<{ products?: Product<F>[] }>;
  requestProposals(request: RequestProposalsRequest): Promise<RequestProposalsResponse<F>>;
  refineProposals(request: RefineProposalsRequest): Promise<{ proposals: Proposal<F>[] }>;
  /** Encodes the proposal back to the wire, then the SDK recomputes terms_digest before it signs. */
  acceptProposal(request: { proposal: Proposal<F>; idempotency_key: string; account: { account_id: string }; name?: string }): Promise<{ media_buy_id: string; revision: number }>;
  getMediaBuys(request: { media_buy_ids: string[] }): Promise<{ media_buys: MediaBuy<F>[] }>;
  onChange(handler: (change: AccountChange) => void | Promise<void>): () => void;
}

/** What a handler knows about its caller. */
export interface BoundContext<A extends string> {
  /** What the transport authenticated, such as { tenant }. */
  identity?: { tenant?: string };
  /** uri@digest keys the caller listed in understood_extensions. */
  understood: Set<string>;
  /** Attributes the caller's tenant enabled. */
  enabled: Set<A>;
  /** May this response carry the extension's must-understand data? The caller listed its exact uri@digest, and the tenant enabled it. */
  understands(attribute: A): boolean;
}

/** The core tasks a seller serves, with the app's forms. */
export interface CoreTasks<F extends HookForms> {
  get_products: { request: GetProductsRequest; response: { products?: Product<F>[] } };
  request_proposals: { request: RequestProposalsRequest; response: RequestProposalsResponse<F> };
  refine_proposals: { request: RefineProposalsRequest; response: { proposals: Proposal<F>[] } };
  accept_proposal: { request: AcceptProposalRequest; response: { media_buy_id: string; revision: number; accepted_proposal_id?: string } };
  get_media_buys: { request: { media_buy_ids: string[] }; response: { status?: 'completed'; media_buys: MediaBuy<F>[] } };
}

type Answer<T> = T | Promise<T>;

/** The seller server of a generated binding. T is the generated Tasks map (one entry per contributed task). */
/** The generated Tasks map: one entry per contributed task. */
export type TaskMap<T> = { [K in keyof T]: { request: unknown; response: unknown } };

export interface BoundServer<F extends HookForms, T extends TaskMap<T>, A extends string> {
  /** Serve a core task: the request arrives as attributes, the response is encoded to the wire and validated. */
  handle<K extends keyof CoreTasks<F>>(task: K, handler: (request: CoreTasks<F>[K]['request'], ctx: BoundContext<A>) => Answer<CoreTasks<F>[K]['response']>): this;
  /** Serve a task an extension contributes, under a transport name (default `x_<task>`). */
  handle<K extends keyof T & string>(task: K, handler: (request: T[K]['request'], ctx: BoundContext<A>) => Answer<T[K]['response']>, options?: { name?: `x_${string}` }): this;
  /** terms_digest of commercial_terms given as attributes: what the seller signs. */
  termsDigest(terms: F['commercial_terms']): string;
  publish<C extends object>(change: C): C;
  /** The transport for a caller with no tenant (every extension enabled when `tenants` is not set). */
  transport: { call(name: string, request: object): Promise<any>; subscribe(fn: (record: any) => void): () => void };
  /** The transport a caller of `tenant` reaches: capabilities, ctx.understands(), and tasks follow that tenant's enablement. */
  transportFor(tenant: string): { call(name: string, request: object): Promise<any>; subscribe(fn: (record: any) => void): () => void };
}

export interface ServerOptions<A extends string> {
  protocols?: string[];
  /** Per-tenant enablement: tenant -> the attributes it enabled. The layer is the superset. */
  tenants?: Record<string, readonly A[]>;
}

export function createBoundClient(binding: Binding, options: ClientOptions): Promise<BoundClient<HookForms>>;
export function createBoundServer(binding: Binding, options?: ServerOptions<string>): BoundServer<HookForms, {}, string>;
export type { SellerRejection };
