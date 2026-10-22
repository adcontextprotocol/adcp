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
    const commercialRelationship = kit?.commercial_relationship;
    return {
        ...(commercialRelationship !== undefined && {
            commercial_relationship: commercialRelationship,
        }),
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
    if ((storyboardId === 'billing_gate_dispatch' ||
        storyboardId === 'comply_controller_mode_gate' ||
        storyboardId === 'security_baseline') &&
        kit?.auth?.api_key) {
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
/** Training-agent tenants served under `<base>/<tenant>/mcp` by one process. */
export const TRAINING_AGENT_TENANTS = new Set([
    'signals',
    'sales',
    'governance',
    'creative',
    'creative-builder',
    'brand',
    'si',
]);
/**
 * Authored context keys that name the governed agent under test. Governed
 * storyboards bind the governance token's `aud` to this value and tell the
 * runner to override it with the endpoint under test.
 */
export const GOVERNED_AGENT_CONTEXT_KEYS = [
    'seller_agent_url',
    'signal_agent_url',
    'brand_agent_url',
    'creative_agent_url',
];
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
export function multiAgentRoutingForStoryboard(input) {
    const { storyboard } = input;
    if (!storyboard.requires?.includes('multi_agent'))
        return { kind: 'single_agent' };
    const defaultAgent = storyboard.default_agent;
    if (!defaultAgent) {
        throw new Error(`${storyboard.id} requires multi_agent but declares no default_agent; cannot tell which tenant is under test`);
    }
    if (defaultAgent !== input.tenantPath) {
        throw new Error(`${storyboard.id} routes its default_agent "${defaultAgent}" but is running under tenant "${input.tenantPath}"; run it from the ${defaultAgent} tenant`);
    }
    const keys = new Set([defaultAgent]);
    for (const phase of storyboard.phases ?? []) {
        for (const step of phase.steps ?? []) {
            if (step.agent !== undefined)
                keys.add(step.agent);
        }
    }
    const base = input.trainingAgentBaseUrl.replace(/\/+$/, '');
    const agents = {};
    for (const key of keys) {
        if (!TRAINING_AGENT_TENANTS.has(key)) {
            throw new Error(`${storyboard.id} routes agent key "${key}", which is not a training-agent tenant`);
        }
        agents[key] = {
            url: key === defaultAgent ? input.tenantAgentUrl : `${base}/${key}/mcp`,
            ...(input.auth && { auth: input.auth }),
        };
    }
    // The governed tenant identifies itself as `<canonical base>/<tenant>`; that
    // is the audience it verifies, so it is the value the buyer must name.
    const identityBase = input.serviceIdentityBase.replace(/\/+$/, '');
    const context = {};
    for (const key of GOVERNED_AGENT_CONTEXT_KEYS) {
        if (storyboard.context?.[key] !== undefined)
            context[key] = `${identityBase}/${defaultAgent}`;
    }
    return { kind: 'routed', agents, default_agent: defaultAgent, context };
}
//# sourceMappingURL=storyboard-runner-options.js.map