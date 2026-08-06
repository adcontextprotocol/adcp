/**
 * Per-tenant probe-task override for security_baseline's auth probes.
 *
 * Most shared test-kits declare `auth.probe_task: list_creatives`, but cached
 * prerelease kits can lag the allowlist. Sales/creative explicitly pin the
 * allowlisted protected read they serve. /signals and /governance serve
 * different SDK-allowlisted protected reads.
 */
export const PROBE_TASK_BY_TENANT = {
    sales: 'list_creatives',
    creative: 'list_creatives',
    signals: 'get_signals',
    governance: 'list_content_standards',
};
/**
 * Thread the test-kit's auth material through to the storyboard runner so
 * kit-gated auth phases execute instead of being skipped by `skip_if`.
 */
export function testKitOptionsFromKit(kit, tenantPath = process.env.TENANT_PATH) {
    const auth = kit?.auth;
    if (!auth?.api_key && !auth?.basic && !auth?.probe_task)
        return undefined;
    if (!auth.probe_task) {
        throw new Error('test kit declares auth credentials without auth.probe_task — required by runner');
    }
    const probeTask = (tenantPath && PROBE_TASK_BY_TENANT[tenantPath]) ?? auth.probe_task;
    return {
        auth: {
            ...(auth.api_key !== undefined && { api_key: auth.api_key }),
            ...(auth.basic !== undefined && { basic: auth.basic }),
            probe_task: probeTask,
        },
    };
}
/**
 * Pick run-scoped transport auth for the manual storyboard runner.
 *
 * `security_baseline` positive credential probes use normal initialized
 * transport calls, so a single run can only prove one static credential type.
 * Dual-credential kits must be split into per-mechanism runs before they can
 * be graded safely here.
 */
export function authForStoryboard(storyboardId, kit, defaultBearerToken) {
    if (storyboardId === 'security_baseline' && kit?.auth?.api_key && kit.auth.basic) {
        throw new Error('security_baseline test kit declares both auth.api_key and auth.basic; manual runner cannot grade both initialized-session credential paths in one run');
    }
    if ((storyboardId === 'billing_gate_dispatch' || storyboardId === 'security_baseline') && kit?.auth?.api_key) {
        return { type: 'bearer', token: kit.auth.api_key };
    }
    if (storyboardId === 'security_baseline' && kit?.auth?.basic) {
        const { username, password, credentials } = kit.auth.basic;
        if (typeof username === 'string' && username && typeof password === 'string') {
            return { type: 'basic', username, password };
        }
        if (typeof credentials === 'string') {
            const colonIndex = credentials.indexOf(':');
            if (colonIndex > 0) {
                return {
                    type: 'basic',
                    username: credentials.slice(0, colonIndex),
                    password: credentials.slice(colonIndex + 1),
                };
            }
        }
        throw new Error('security_baseline auth.basic must provide a non-empty username and a password string, or credentials in "username:password" form; the password may be empty');
    }
    return { type: 'bearer', token: defaultBearerToken };
}
//# sourceMappingURL=storyboard-runner-options.js.map