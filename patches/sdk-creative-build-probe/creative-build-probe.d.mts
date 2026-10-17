import type { FixtureMatchClause, StoryboardContext } from './types.mjs';
export interface CreativeBuildProbeSpec {
    context_prefix: string;
    message: string;
}
export interface CreativeBuildProbeInputFixture {
    match: FixtureMatchClause[];
    /** Operator-provisioned valid input for every route matched by this recipe. */
    input: Record<string, unknown>;
}
export type CreativeBuildProbeResolution = {
    status: 'resolved';
    capabilityId: string;
    context: StoryboardContext;
    source: 'generation' | 'test_kit';
    requirements: FixtureMatchClause[];
} | {
    status: 'unsatisfied';
    detail: string;
} | {
    status: 'failed';
    detail: string;
};
export declare function validateCreativeBuildProbeSpec(value: unknown): asserts value is CreativeBuildProbeSpec;
/**
 * Uses only actual catalog entries and explicitly provisioned test-kit inputs.
 * Global generation support does not identify a generation route in a mixed
 * catalog: the automatic brief recipe is therefore used only when the catalog
 * has exactly one build route (including legacy unaddressable build entries),
 * and a complete, understood declaration proves there are no technical seeds.
 * Other modes require a matching operator recipe, not inferred source assets.
 */
export declare function resolveCreativeBuildProbe(creative: unknown, spec: CreativeBuildProbeSpec, testKit?: unknown, adcpVersion?: string, governanceEnforcement?: unknown): CreativeBuildProbeResolution;
