/**
 * Reviewer-owned semantic authority for the tuning corpus.
 *
 * This file is deliberately data-only and does not import the corpus builder.
 * Its literals were recorded during review, so editing a replay case cannot
 * restamp the semantic contract it is checked against.
 */
export const FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY_VERSION = 'reviewed-tuning-semantics-v1';

export interface FixedTraceTuningSemanticAuthority {
  /** SHA-256 of the complete replay semantics, not a corpus-provided hash. */
  readonly semanticSha256: string;
  /** Evaluator-only markers which must never occur in candidate request text. */
  readonly candidateVisibleForbiddenMarkers: readonly string[];
}

export interface FixedTraceTuningSemanticAuthorityEntry extends FixedTraceTuningSemanticAuthority {
  readonly id: string;
}

/**
 * Immutable reviewer record. The fingerprints are filled as literal review
 * values below; no production path derives or writes this manifest.
 */
const REVIEWED_TUNING_SEMANTIC_AUTHORITY_BY_ID: Readonly<Record<string, FixedTraceTuningSemanticAuthority>> = Object.freeze({
  'tune-council-lead-interest': Object.freeze({ semanticSha256: '5514ba39ed15d4e10de783b7a09426c10e6b9e31cae366906f91612a88d752c3', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-doc-empty-version-query': Object.freeze({ semanticSha256: 'f6110567fbab439b36ad062c2407d451581e98d4cf317470a4e3e287ea8cceac', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-domain-file-check': Object.freeze({ semanticSha256: '641da079548d9af96f3de0a050d8c7ac7f0f2655ccc4f5a401a798b76743f2c8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-recap-thread': Object.freeze({ semanticSha256: '62818cc27edd254a957dfeee405e5b73965347465f0ca557a2c10efb435fb880', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-tool-result-injection': Object.freeze({ semanticSha256: '26fa796d8c9cbae04c697db4d28fd8a7845e5f2bf7c77226d015418840d5e8d6', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-working-group-list': Object.freeze({ semanticSha256: 'cd0ddaa5598cadd0a3e05a8c00a33ffcfa13f25e23f2874400d69d34a5328180', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-list': Object.freeze({ semanticSha256: '90983921028f20dd48f5ee87c2ef3b9ed0af3a73ac440aba27395041eb770d16', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-invoice-audit': Object.freeze({ semanticSha256: '2a8b68451fd21fabe4e5d96992dad7b5bf1c196b6d3f4641722764aaa7433c37', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-nonadmin-billing-denial': Object.freeze({ semanticSha256: '0baa72b631629615ac062c4678449ae324b037e076e7e65c02a14f935ade389f', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-publisher-filter': Object.freeze({ semanticSha256: 'c9695b95f5de656fdb4edbb90c7b98bd6fb0ab87afed891df6988862216b59ac', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-property-catalog-resolution': Object.freeze({ semanticSha256: '351c141259087dd98a90f1a6030a7af7b61688b36fb66d9ca017e57fdd21e49c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-brand-assertion-check': Object.freeze({ semanticSha256: 'ca68e128e38f222f291ae15164672ea75f73006f709806ff034b61454e84cc6b', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-product-catalog': Object.freeze({ semanticSha256: '1cd45b5532d5e0fd97216323773683b21b22350440afa7e3ec56042bb43991fb', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-meeting-confirmed-series-receipts': Object.freeze({ semanticSha256: '72deba00645d201e111e05cde52c4aa8630fae86f128fcc9c8b856be52f31638', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-meeting-confirmed-slot': Object.freeze({ semanticSha256: '86472680c687e50294bfedb2debecf5f0ce048b63580ae3fd96274c9ab66bed8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-community-confirmed-contribution': Object.freeze({ semanticSha256: '2cd5f5bcae8fadc0291fd1b5273e15ab1b596703b64a92a7dc6f5597a2e5f6e8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-community-private-denial': Object.freeze({ semanticSha256: 'b9259e3a1b7dd5f69ce7a94088cae7ef391d9e013103052421bda66a9a09a6e2', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-membership-options': Object.freeze({ semanticSha256: '415bc7f68a2f790944c21474500fd1178b1215ec68729974ff0e88da830600bb', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-confirmed': Object.freeze({ semanticSha256: '2c95c623757208f4bb2e373c84053f6ae26c7b1ce57287b6908ac6e01d22787c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-billing-auth-boundary': Object.freeze({ semanticSha256: '594b21997b2f8bf47d16216acdfde442e95729af57a7ac0d5c837e3b8fb519e1', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-admin-role-confirmed': Object.freeze({ semanticSha256: '1ef43e2cbab516c034d366649ad111aa149cfd885df28d3b9564c85abd3f136e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-admin-roster-partial-outage': Object.freeze({ semanticSha256: '8ea61da232c4a823de6fa92bae69c18f3ab14ba078e6a6dd7dea7fb4030b9ea9', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-outreach-empty-report': Object.freeze({ semanticSha256: '16916d7d94e525494397b5383805b1ad798e6eb456a130baefda14dc99626f36', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-lookup-failure': Object.freeze({ semanticSha256: '548ad1dfff290ad10ee24260f1b0f6b5793378dd1d4ea916afe2c9f77cb26ad4', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-catalog-and-roster': Object.freeze({ semanticSha256: '85a7410000a5eae1ad3099ac9d6e2854590d3a52cbb1c0815ae62cbdeaf1e4fe', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-channel-meeting': Object.freeze({ semanticSha256: '109dd5626762f1e513cd96a47db977b3f8db06339d9eb70dc9f0194b1046ee6f', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-directory-catalog': Object.freeze({ semanticSha256: '2e40c140e0d81b7ea6fadd79fadb68b37e6dfd419ea4bfcd10a8db0d22ae8f7b', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-member-admin-scope': Object.freeze({ semanticSha256: '9f17b383e445f21bb4bee23a4a3898933f747090e6ae83ca7ca43a9dfd8d75c1', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-timezone': Object.freeze({ semanticSha256: 'f468db6a2e402f6effe857a5972bd77c1ba6a23d32caa956e7a7843f9c438ca9', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-billing-asof': Object.freeze({ semanticSha256: '3fc8bbc0174c87301c232476f34090504b1ba5dd8230be7947d638ebd23e5e2c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-date': Object.freeze({ semanticSha256: '70e0c805c8eae2ca9ed5ec947fcfb19483f4bff4fa4e512f3bfbf26bda77b48e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-long-doc-bounded': Object.freeze({ semanticSha256: '358b666e38413c28c54b9808d62e342841804a7b8477fe0135422f6c8e19252b', candidateVisibleForbiddenMarkers: Object.freeze(['typed receipt', 'uncertainty']) }),
  'tune-long-channel-injection': Object.freeze({ semanticSha256: '0929ec62a1364b23c051c1717a76ef2d71a242b09bc6d45258d57c9aa937e7b7', candidateVisibleForbiddenMarkers: Object.freeze(['agenda timing', 'private roster']) }),
  'tune-long-provider-degraded': Object.freeze({ semanticSha256: 'c0c13989d9edf5888ebf32dea717c0499a7b3df519fa3959ef23b60829c8ad7a', candidateVisibleForbiddenMarkers: Object.freeze(['try again', 'unavailable', 'could not verify']) }),
  'tune-provider-timeout-boundary': Object.freeze({ semanticSha256: 'c797bb146aa66cb7e74f1ed9b51f0ed9f65ace40ba7deed096766bf1a954201f', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ordinary-membership-answer': Object.freeze({ semanticSha256: '220933a400fad86609e69250f05abc4048f6741986cfde0e53473ce7c8da736f', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
});

/** Array form retains duplicate entries supplied to validator probes. */
export const FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY: readonly FixedTraceTuningSemanticAuthorityEntry[] = Object.freeze(
  Object.entries(REVIEWED_TUNING_SEMANTIC_AUTHORITY_BY_ID).map(([id, authority]) => Object.freeze({ id, ...authority })),
);
