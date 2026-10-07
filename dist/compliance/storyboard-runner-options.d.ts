import type { StoryboardRunOptions } from '@adcp/sdk/testing';
export interface LoadedTestKit {
    brand?: {
        house?: {
            domain?: string;
        };
        brand_id?: string;
    };
    commercial_relationship?: string;
    auth?: {
        api_key?: string;
        basic?: {
            username?: string;
            password?: string;
            credentials?: string;
        };
        probe_task?: string;
    };
}
/**
 * Per-tenant probe-task override for security_baseline's auth probes.
 *
 * Most shared test-kits declare `auth.probe_task: list_creatives`, but cached
 * prerelease kits can lag the allowlist. Sales/creative explicitly pin the
 * allowlisted protected read they serve. /signals and /governance serve
 * different SDK-allowlisted protected reads.
 */
export declare const PROBE_TASK_BY_TENANT: Record<string, string>;
/**
 * Thread the test-kit's auth material through to the storyboard runner so
 * kit-gated auth phases execute instead of being skipped by `skip_if`.
 */
export declare function testKitOptionsFromKit(kit: LoadedTestKit | undefined, tenantPath?: string | undefined): StoryboardRunOptions['test_kit'] | undefined;
/**
 * Pick run-scoped transport auth for the manual storyboard runner.
 *
 * `security_baseline` positive credential probes use normal initialized
 * transport calls, so a single run can only prove one static credential type.
 * Dual-credential kits must be split into per-mechanism runs before they can
 * be graded safely here.
 */
export declare function authForStoryboard(storyboardId: string, kit: LoadedTestKit | undefined, defaultBearerToken: string): StoryboardRunOptions['auth'];
/** Training-agent tenants served under `<base>/<tenant>/mcp` by one process. */
export declare const TRAINING_AGENT_TENANTS: ReadonlySet<string>;
/** Structural subset of a storyboard the multi-agent router reads. */
export interface MultiAgentStoryboardShape {
    id: string;
    requires?: readonly string[];
    default_agent?: string;
    context?: Record<string, unknown>;
    phases?: ReadonlyArray<{
        steps?: ReadonlyArray<{
            agent?: string;
        }>;
    }>;
}
export interface MultiAgentRoutingInput {
    storyboard: MultiAgentStoryboardShape;
    /** Tenant whose job is running the storyboard (TENANT_PATH). */
    tenantPath: string;
    /** Endpoint of the tenant under test. */
    tenantAgentUrl: string;
    /** Path-routed base serving every tenant, e.g. `http://127.0.0.1:1234/api/training-agent`. */
    trainingAgentBaseUrl: string;
    /**
     * Canonical base the training agent identifies its tenants under
     * (`<base>/<tenant>` is the audience a governed tenant verifies).
     */
    serviceIdentityBase: string;
    auth: StoryboardRunOptions['auth'];
}
/**
 * Authored context keys that name the governed agent under test. Governed
 * storyboards bind the governance token's `aud` to this value and tell the
 * runner to override it with the endpoint under test.
 */
export declare const GOVERNED_AGENT_CONTEXT_KEYS: readonly ['seller_agent_url', 'signal_agent_url', 'brand_agent_url', 'creative_agent_url'];
export type MultiAgentRouting = {
    kind: 'single_agent';
} | {
    kind: 'routed';
    agents: NonNullable<StoryboardRunOptions['agents']>;
    default_agent: string;
    context: Record<string, string>;
};
/**
 * Route a `requires: [multi_agent]` storyboard across training-agent tenants.
 *
 * Storyboard agent keys name training-agent tenants (`sales`, `governance`,
 * `brand`, `signals`, `creative-builder`, ...). The storyboard's
 * `default_agent` is the agent under test, so it must be the tenant whose job
 * is running it; it keeps the exact tenant URL the job selected. Every other
 * key routes to its sibling tenant in the same training-agent process with the
 * same credentials. Controller seeding follows the routed agent that owns
 * each fixture. The authored context keys that name the governed agent
 * (`signal_agent_url`, ...) are overridden with that tenant's service
 * identity, as the storyboards' prerequisites instruct. Storyboards that do
 * not require `multi_agent` are left untouched so single-tenant runs keep
 * their existing behavior.
 */
export declare function multiAgentRoutingForStoryboard(input: MultiAgentRoutingInput): MultiAgentRouting;
//# sourceMappingURL=storyboard-runner-options.d.ts.map