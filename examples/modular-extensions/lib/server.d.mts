// Types for lib/server.mjs, the seller-side helper. Kernel and module task payloads are typed
// loosely (`any`), as in lib/client.d.mts; contributed tasks are typed by their generated
// descriptors, so a handler's request and response types come from the extension's schema.
import type { ContributedTask, ExtensionEntry } from '../packages/core/src/index.ts';

export class SellerRejection extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}

/** A generated extension module, as the server sees it. */
export interface ExtensionModule {
  EXTENSION_URI: string;
  EXTENSION_DIGEST: string;
  EXTENSION_VERSION: string;
  EXTENSION_MODULE_DIR: URL;
}

/** A published version from the registry: an older digest with no generated module in this agent. */
export interface RegistryVersion {
  uri: string;
  version: string;
  digest: string;
  bytes: Uint8Array;
}

/** One declared uri@digest, as the server keeps it. */
export interface Declaration {
  uri: string;
  digest: string;
  version: string;
  points?: string[];
  capabilities?: object;
}

/** What a handler knows about its caller. */
export interface HandlerContext {
  /** What the transport authenticated (the third argument of transport.call), such as { tenant }. */
  identity?: { tenant?: string };
  /** uri@digest keys the caller listed in understood_extensions. */
  understood: Set<string>;
  /** The highest declared version of `uri` the caller understands, or null: send its data, or omit it. */
  agreed(uri: string): Declaration | null;
}

/** The request and response types a generated task descriptor carries. */
export type RequestOf<T> = T extends ContributedTask<infer Req, any> ? Req : never;
export type ResponseOf<T> = T extends ContributedTask<any, infer Res> ? Res : never;
/** The handler of a contributed task, typed from its descriptor. */
export type TaskHandler<T> = (request: RequestOf<T>, ctx: HandlerContext) => ResponseOf<T> | Promise<ResponseOf<T>>;

export type CoreTaskName = 'get_products' | 'request_proposals' | 'refine_proposals' | 'accept_proposal' | 'get_media_buys';

export interface AdcpServer {
  declared: Declaration[];
  /** Declare an extension this agent emits (a package's module or a registry version). A generated layer's createServer() declares the app's extensions. */
  declare(extension: ExtensionModule | RegistryVersion, options?: { points?: string[]; capabilities?: object }): Declaration;
  /** Serve a contributed task by its descriptor under a transport name (default `x_<task>`). A generated layer has server.handle('<task>', handler). */
  handle<T extends ContributedTask<any, any>>(task: T, handler: NoInfer<TaskHandler<T>>, options?: { name?: `x_${string}` }): AdcpServer;
  /** Serve a kernel or module task; the server validates its request and response against core. */
  handle(task: CoreTaskName, handler: (request: any, ctx: HandlerContext) => object | Promise<object>): AdcpServer;
  /** The envelope { uri, digest, data } for a declared version that has no generated writer. */
  entry(declaration: Declaration, data: object): ExtensionEntry;
  /** Validate and send an account.change_recorded record on the core change feed. */
  publish<C extends object>(change: C): C;
  assertCore(schemaId: string, payload: unknown, side: string, code?: string): void;
  transport: { call(name: string, request: object, identity?: { tenant?: string }): Promise<any>; subscribe(fn: (record: any) => void): () => void };
}

export function createAdcpServer(options?: { protocols?: string[]; ignoreUnderstood?: boolean }): AdcpServer;
export function fromRegistry(uri: string, version: string, registry?: string): RegistryVersion;
