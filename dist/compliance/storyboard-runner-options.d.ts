import type { StoryboardRunOptions } from '@adcp/sdk/testing';
export interface LoadedTestKit {
    brand?: {
        house?: {
            domain?: string;
        };
        brand_id?: string;
    };
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
export declare function testKitOptionsFromKit(kit: LoadedTestKit | undefined, tenantPath?: any): StoryboardRunOptions['test_kit'] | undefined;
/**
 * Pick run-scoped transport auth for the manual storyboard runner.
 *
 * `security_baseline` positive credential probes use normal initialized
 * transport calls, so a single run can only prove one static credential type.
 * Dual-credential kits must be split into per-mechanism runs before they can
 * be graded safely here.
 */
export declare function authForStoryboard(storyboardId: string, kit: LoadedTestKit | undefined, defaultBearerToken: string): StoryboardRunOptions['auth'];
//# sourceMappingURL=storyboard-runner-options.d.ts.map