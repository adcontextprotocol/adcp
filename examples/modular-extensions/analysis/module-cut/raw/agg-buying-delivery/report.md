# Schema churn report

Head `45591e97b3`, first-parent since 2025-10-19, placement `raw/buying-delivery/placement.json`.

Commits touching schemas (excluding the bootstrap commit): 839. File changes: 5028.

Placement source: placement 4841, placement-via-rename 111, dir-heuristic 39, referrers 37

## By layer (all windows)

| layer | commits | commits w/ non-add | file changes | fc non-add | fc additive | fc annot. | rec additive | rec non-add | rec annot. | distinct files |
|---|---|---|---|---|---|---|---|---|---|---|
| kernel | 196 | 22 | 307 | 27 | 162 | 118 | 190 | 41 | 319 | 65 |
| module | 645 | 249 | 4110 | 820 | 2202 | 1088 | 4332 | 1517 | 3069 | 974 |
| extension | 4 | 0 | 4 | 0 | 4 | 0 | 4 | 0 | 0 | 4 |
| assembly | 417 | 59 | 602 | 70 | 187 | 345 | 403 | 132 | 697 | 18 |
| retire | 4 | 0 | 5 | 0 | 3 | 2 | 3 | 0 | 0 | 5 |
| total | 839 | 283 | 5028 | 917 | 2558 | 1553 | 4932 | 1690 | 4085 | 1066 |

## By layer and release window

| window | layer | commits | commits w/ non-add | file changes | fc non-add | fc additive | fc annot. | rec additive | rec non-add | rec annot. | distinct files |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pre-3.0 | kernel | 64 | 11 | 109 | 12 | 67 | 30 | 84 | 21 | 83 | 39 |
| pre-3.0 | module | 209 | 96 | 1698 | 400 | 944 | 354 | 1837 | 770 | 948 | 452 |
| pre-3.0 | assembly | 130 | 21 | 192 | 24 | 62 | 106 | 177 | 52 | 216 | 14 |
| pre-3.0 | retire | 2 | 0 | 3 | 0 | 1 | 2 | 1 | 0 | 0 | 3 |
| pre-3.0 | **total** | 252 | 108 | 2002 | 436 | 1074 | 492 | 2099 | 843 | 1247 | 508 |
| 3.0->3.1 | kernel | 67 | 7 | 96 | 8 | 54 | 34 | 60 | 11 | 118 | 30 |
| 3.0->3.1 | module | 193 | 54 | 900 | 174 | 458 | 268 | 843 | 312 | 789 | 372 |
| 3.0->3.1 | extension | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| 3.0->3.1 | assembly | 143 | 9 | 186 | 11 | 55 | 120 | 87 | 12 | 229 | 16 |
| 3.0->3.1 | retire | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| 3.0->3.1 | **total** | 288 | 64 | 1184 | 193 | 569 | 422 | 992 | 335 | 1136 | 420 |
| 3.1->3.2 | kernel | 51 | 3 | 86 | 6 | 39 | 41 | 44 | 8 | 98 | 35 |
| 3.1->3.2 | module | 186 | 80 | 1286 | 208 | 702 | 376 | 1461 | 389 | 1156 | 597 |
| 3.1->3.2 | extension | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| 3.1->3.2 | assembly | 115 | 22 | 190 | 28 | 61 | 101 | 121 | 60 | 224 | 13 |
| 3.1->3.2 | retire | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| 3.1->3.2 | **total** | 235 | 88 | 1564 | 242 | 804 | 518 | 1628 | 457 | 1478 | 647 |
| 3.2->now | kernel | 14 | 1 | 16 | 1 | 2 | 13 | 2 | 1 | 20 | 9 |
| 3.2->now | module | 57 | 19 | 226 | 38 | 98 | 90 | 191 | 46 | 176 | 154 |
| 3.2->now | extension | 2 | 0 | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 2 |
| 3.2->now | assembly | 29 | 7 | 34 | 7 | 9 | 18 | 18 | 8 | 28 | 5 |
| 3.2->now | **total** | 64 | 23 | 278 | 46 | 111 | 121 | 213 | 55 | 224 | 170 |

## By module (all windows)

| module | layer | commits | commits w/ non-add | file changes | fc non-add | fc additive | fc annot. | rec additive | rec non-add | rec annot. | distinct files |
|---|---|---|---|---|---|---|---|---|---|---|---|
| kernel | kernel | 155 | 15 | 227 | 18 | 121 | 88 | 134 | 29 | 253 | 39 |
| kernel-types | kernel | 58 | 7 | 80 | 9 | 41 | 30 | 56 | 12 | 66 | 26 |
| module:buying | module | 354 | 114 | 1524 | 272 | 866 | 386 | 1652 | 486 | 1102 | 354 |
| module:creative | module | 198 | 71 | 949 | 204 | 481 | 264 | 1051 | 423 | 767 | 228 |
| module:governance | module | 73 | 29 | 461 | 112 | 236 | 113 | 418 | 214 | 229 | 83 |
| module:accounts | module | 75 | 21 | 233 | 35 | 114 | 84 | 192 | 62 | 222 | 52 |
| module:signals | module | 80 | 28 | 226 | 52 | 109 | 65 | 212 | 77 | 160 | 51 |
| module:media-vocabulary | module | 76 | 14 | 188 | 15 | 128 | 45 | 194 | 21 | 129 | 76 |
| module:reporting | module | 37 | 14 | 136 | 28 | 80 | 28 | 151 | 55 | 103 | 56 |
| module:identity | module | 76 | 19 | 127 | 28 | 77 | 22 | 218 | 44 | 137 | 34 |
| module:compliance-testing | module | 61 | 28 | 91 | 32 | 33 | 26 | 120 | 58 | 108 | 4 |
| module:trusted-match | module | 35 | 16 | 91 | 32 | 30 | 29 | 64 | 65 | 74 | 16 |
| module:sponsored-intelligence | module | 17 | 4 | 84 | 10 | 48 | 26 | 60 | 12 | 38 | 20 |
| extension:response-signing-jws | extension | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| extension:aao-verification-token | extension | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| extension:adcp-ext-namespace | extension | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| extension:spot-lifecycle | extension | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 |
| assembly | assembly | 417 | 59 | 602 | 70 | 187 | 345 | 403 | 132 | 697 | 18 |
| retire | retire | 4 | 0 | 5 | 0 | 3 | 2 | 3 | 0 | 0 | 5 |

## By module and window: file changes (non-additive)

| module | layer | pre-3.0 | 3.0->3.1 | 3.1->3.2 | 3.2->now |
|---|---|---|---|---|---|
| kernel | kernel | 68 (7) | 83 (8) | 63 (2) | 13 (1) |
| kernel-types | kernel | 41 (5) | 13 (0) | 23 (4) | 3 (0) |
| module:buying | module | 537 (122) | 263 (45) | 596 (84) | 128 (21) |
| module:creative | module | 420 (117) | 221 (38) | 268 (42) | 40 (7) |
| module:governance | module | 308 (73) | 105 (26) | 42 (13) | 6 (0) |
| module:accounts | module | 73 (15) | 64 (8) | 89 (11) | 7 (1) |
| module:signals | module | 111 (26) | 71 (19) | 32 (4) | 12 (3) |
| module:media-vocabulary | module | 71 (9) | 49 (2) | 58 (2) | 10 (2) |
| module:reporting | module | 14 (4) | 6 (1) | 110 (21) | 6 (2) |
| module:identity | module | 62 (18) | 35 (9) | 17 (0) | 13 (1) |
| module:compliance-testing | module | 8 (2) | 40 (16) | 40 (13) | 3 (1) |
| module:trusted-match | module | 32 (8) | 24 (6) | 34 (18) | 1 (0) |
| module:sponsored-intelligence | module | 62 (6) | 22 (4) | 0 (0) | 0 (0) |
| extension:response-signing-jws | extension | 0 (0) | 1 (0) | 0 (0) | 0 (0) |
| extension:aao-verification-token | extension | 0 (0) | 0 (0) | 1 (0) | 0 (0) |
| extension:adcp-ext-namespace | extension | 0 (0) | 0 (0) | 0 (0) | 1 (0) |
| extension:spot-lifecycle | extension | 0 (0) | 0 (0) | 0 (0) | 1 (0) |
| assembly | assembly | 192 (24) | 186 (11) | 190 (28) | 34 (7) |
| retire | retire | 3 (0) | 1 (0) | 1 (0) | 0 (0) |

## Non-additive records in kernel files: 41 (in 27 file changes, 22 commits)

| window | kind | records |
|---|---|---|
| 3.0->3.1 | bound-tightened | 1 |
| 3.0->3.1 | conditional-added | 1 |
| 3.0->3.1 | enum-value-removed | 2 |
| 3.0->3.1 | oneOf-dropped | 1 |
| 3.0->3.1 | property-removed | 4 |
| 3.0->3.1 | required-added | 2 |
| 3.1->3.2 | bound-tightened | 2 |
| 3.1->3.2 | pattern-changed | 6 |
| 3.2->now | allOf-added | 1 |
| pre-3.0 | allOf-added | 1 |
| pre-3.0 | bound-tightened | 9 |
| pre-3.0 | enum-value-removed | 3 |
| pre-3.0 | file-removed | 1 |
| pre-3.0 | property-removed | 3 |
| pre-3.0 | ref-introduced | 1 |
| pre-3.0 | required-added | 2 |
| pre-3.0 | type-added | 1 |

Released status of the element each kernel non-additive record touched:

| window | status | records |
|---|---|---|
| 3.0->3.1 | never-released | 6 |
| 3.0->3.1 | prerelease-only | 3 |
| 3.0->3.1 | released-GA | 2 |
| 3.1->3.2 | prerelease-only | 3 |
| 3.1->3.2 | released-GA | 5 |
| 3.2->now | released-GA | 1 |
| pre-3.0 | never-released | 3 |
| pre-3.0 | prerelease-only | 3 |
| pre-3.0 | released-GA | 15 |

Release status of non-additive records, all layers:

| layer | window | released-GA | prerelease-only | never-released |
|---|---|---|---|---|
| kernel | pre-3.0 | 15 | 3 | 3 |
| kernel | 3.0->3.1 | 2 | 3 | 6 |
| kernel | 3.1->3.2 | 5 | 3 | 0 |
| kernel | 3.2->now | 1 | 0 | 0 |
| module | pre-3.0 | 210 | 344 | 216 |
| module | 3.0->3.1 | 188 | 65 | 59 |
| module | 3.1->3.2 | 261 | 83 | 45 |
| module | 3.2->now | 44 | 0 | 2 |
| assembly | pre-3.0 | 6 | 19 | 27 |
| assembly | 3.0->3.1 | 7 | 2 | 3 |
| assembly | 3.1->3.2 | 58 | 1 | 1 |
| assembly | 3.2->now | 8 | 0 | 0 |

## Co-change

Aggregator files (assembly layer): `adagents.json`, `core/async-response-data.json`, `core/mcp-webhook-payload.json`, `core/tasks-get-response.json`, `core/tasks-list-response.json`, `core/x-entity-types.json`, `enums/adcp-protocol.json`, `enums/notification-type.json`, `enums/specialism.json`, `enums/task-type.json`, `extensions/index.json`, `index.json`, `manifest.schema.json`, `protocol/get-adcp-capabilities-response.json`, `protocol/get-task-status-response.json`, `protocol/list-tasks-response.json`


### all|caps-as-aggregator

| category | commits | share of multi-module |
|---|---|---|
| single-module | 434 | – |
| aggregator-only | 110 | 27% |
| kernel-internal | 0 | 0% |
| kernel+one-module | 54 | 13% |
| cross-module | 241 | 60% |
| total | 839 |  |

Cross-module commits by number of non-kernel modules: 2: 144, 3: 51, 4: 25, 5: 8, 6+: 13


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:buying | module:creative | 90 |
| module:buying | module:media-vocabulary | 62 |
| module:buying | module:signals | 54 |
| module:buying | module:governance | 38 |
| module:accounts | module:buying | 35 |
| module:creative | module:signals | 32 |
| module:creative | module:governance | 30 |
| module:accounts | module:creative | 28 |
| module:buying | module:identity | 27 |
| module:creative | module:identity | 23 |
| module:accounts | module:governance | 23 |
| module:buying | module:reporting | 22 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 101 | 40 | 0 | 12 | 99 |
| 3.0->3.1 | 181 | 29 | 0 | 18 | 60 |
| 3.1->3.2 | 125 | 32 | 0 | 17 | 61 |
| 3.2->now | 27 | 9 | 0 | 7 | 21 |

### all|caps-split

| category | commits | share of multi-module |
|---|---|---|
| single-module | 434 | – |
| aggregator-only | 84 | 21% |
| kernel-internal | 0 | 0% |
| kernel+one-module | 61 | 15% |
| cross-module | 260 | 64% |
| total | 839 |  |

Cross-module commits by number of non-kernel modules: 2: 155, 3: 52, 4: 27, 5: 12, 6+: 14


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:buying | module:creative | 95 |
| module:buying | module:media-vocabulary | 64 |
| module:buying | module:signals | 58 |
| module:buying | module:governance | 43 |
| module:accounts | module:buying | 40 |
| module:creative | module:signals | 33 |
| module:creative | module:governance | 32 |
| module:buying | module:identity | 28 |
| module:accounts | module:creative | 28 |
| module:buying | module:reporting | 26 |
| module:accounts | module:governance | 25 |
| module:creative | module:identity | 23 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 101 | 27 | 0 | 14 | 110 |
| 3.0->3.1 | 181 | 26 | 0 | 20 | 61 |
| 3.1->3.2 | 125 | 23 | 0 | 19 | 68 |
| 3.2->now | 27 | 8 | 0 | 8 | 21 |

### substantive|caps-as-aggregator

| category | commits | share of multi-module |
|---|---|---|
| single-module | 352 | – |
| aggregator-only | 58 | 22% |
| kernel-internal | 0 | 0% |
| kernel+one-module | 30 | 12% |
| cross-module | 171 | 66% |
| total | 611 |  |

Cross-module commits by number of non-kernel modules: 2: 109, 3: 35, 4: 12, 5: 6, 6+: 9


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:buying | module:creative | 61 |
| module:buying | module:media-vocabulary | 42 |
| module:buying | module:signals | 34 |
| module:buying | module:governance | 24 |
| module:accounts | module:buying | 24 |
| module:buying | module:identity | 22 |
| module:creative | module:governance | 19 |
| module:accounts | module:creative | 19 |
| module:creative | module:identity | 18 |
| module:creative | module:signals | 17 |
| module:accounts | module:governance | 16 |
| module:buying | module:reporting | 14 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 106 | 18 | 0 | 11 | 79 |
| 3.0->3.1 | 118 | 16 | 0 | 7 | 40 |
| 3.1->3.2 | 98 | 19 | 0 | 11 | 38 |
| 3.2->now | 30 | 5 | 0 | 1 | 14 |

### substantive|caps-split

| category | commits | share of multi-module |
|---|---|---|
| single-module | 352 | – |
| aggregator-only | 41 | 16% |
| kernel-internal | 1 | 0% |
| kernel+one-module | 31 | 12% |
| cross-module | 186 | 72% |
| total | 611 |  |

Cross-module commits by number of non-kernel modules: 2: 116, 3: 39, 4: 12, 5: 10, 6+: 9


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:buying | module:creative | 65 |
| module:buying | module:media-vocabulary | 44 |
| module:buying | module:signals | 37 |
| module:buying | module:governance | 28 |
| module:accounts | module:buying | 28 |
| module:buying | module:identity | 22 |
| module:creative | module:governance | 21 |
| module:accounts | module:creative | 19 |
| module:creative | module:identity | 18 |
| module:buying | module:reporting | 17 |
| module:creative | module:signals | 17 |
| module:accounts | module:governance | 17 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 106 | 7 | 1 | 12 | 88 |
| 3.0->3.1 | 118 | 15 | 0 | 8 | 40 |
| 3.1->3.2 | 98 | 14 | 0 | 10 | 44 |
| 3.2->now | 30 | 5 | 0 | 1 | 14 |

Broad cross-module commits (5+ non-kernel modules): 19

| sha | PR | window | modules | subject |
|---|---|---|---|---|
| 309a8807f5 | 646 | pre-3.0 | kernel kernel-types module:buying module:creative module:identity module:media-vocabulary module:reporting module:signals | Allow additional properties in all JSON schemas for forward compatibility (#646) |
| f4ef555547 | 859 | pre-3.0 | kernel kernel-types module:buying module:creative module:governance module:identity module:media-vocabulary module:sponsored-intelligence | Release AdCP v3.0.0-beta.1 (#859) |
| 96a90ec236 | 997 | pre-3.0 | kernel kernel-types module:accounts module:buying module:creative module:governance module:signals | feat: Standardize cursor-based pagination across all list operations (#997) |
| 305b8ec234 | 1022 | pre-3.0 | kernel module:buying module:creative module:governance module:media-vocabulary module:signals | feat(schema): Add minItems: 1 to request-side arrays (#1018) (#1022) |
| 892da1df24 | 1113 | pre-3.0 | kernel-types module:buying module:creative module:governance module:identity module:sponsored-intelligence | feat!: Unify brand identity — delete brand-manifest.json, use brand refs (#1113) |
| 80afa9784c | 1119 | pre-3.0 | module:accounts module:buying module:creative module:reporting module:signals | feat: add sandbox mode as protocol parameter on all tasks (#1119) |
| 142bcd596f | 1179 | pre-3.0 | kernel-types module:accounts module:buying module:creative module:governance module:signals | docs: disclose seller auth model in get_adcp_capabilities (#1179) |
| 544230b7ad | 1252 | pre-3.0 | kernel kernel-types module:accounts module:buying module:creative module:governance module:media-vocabulary module:signals | feat(schema): address 17 schema gaps that block autonomous agent operation (#1252) |
| 257463e7cd | 1593 | pre-3.0 | module:buying module:governance module:identity module:media-vocabulary module:signals | feat: structured audience data for bias/fairness governance (#1389) (#1593) |
| 5ecc29d0c0 | 1622 | pre-3.0 | kernel module:accounts module:buying module:creative module:governance module:identity module:reporting module:signals module:sponsored-intelligence | feat!: seller-assigned IDs, opaque governance context, explicit idempotency (#1622) |
| 7736865ac1 | 1959 | pre-3.0 | kernel module:accounts module:buying module:creative module:governance module:identity module:reporting module:signals module:sponsored-intelligence module:trusted-match | feat: per-request version declaration (adcp_major_version) (#1959) |
| 43586d69cc | 2315 | pre-3.0 | kernel module:accounts module:buying module:creative module:governance module:identity module:reporting module:signals module:sponsored-intelligence | feat(schemas)!: require idempotency_key on all mutating requests (#2315) |
| 6eadf0663c | 3493 | 3.0->3.1 | kernel module:accounts module:buying module:compliance-testing module:creative module:governance module:identity module:reporting module:signals module:sponsored-intelligence module:trusted-match | spec(versioning): release-precision protocol version negotiation (#3493) |
| ca60b16ccf | 4896 | 3.0->3.1 | kernel module:accounts module:buying module:compliance-testing module:creative module:governance module:identity module:reporting module:signals module:sponsored-intelligence module:trusted-match | spec: fold protocol-envelope into per-task response schemas (closes #4878) (#4896) |
| dbc5b56172 |  | 3.0->3.1 | module:accounts module:compliance-testing module:creative module:media-vocabulary module:signals | feat(schemas): improve SDK generation ergonomics |
| 0bb862e076 | 6212 | 3.1->3.2 | extension:webhook-signing kernel kernel-types module:accounts module:buying module:compliance-testing module:creative module:governance module:media-vocabulary | feat(schema): add resource-scoped indicators and warnings (#6212) |
| 877f6a20a0 | 6966 | 3.1->3.2 | extension:request-signing-rfc9421 module:accounts module:buying module:governance module:reporting | feat(protocol): add agent configuration sync (#6966) |
| b7b6ba9171 | 6953 | 3.1->3.2 | extension:request-signing-rfc9421 extension:webhook-signing kernel module:accounts module:buying module:reporting | feat(reporting): add managed reporting status schemas (#6953) |
| dd6ab0bce3 | 7228 | 3.1->3.2 | extension:webhook-signing module:accounts module:buying module:compliance-testing module:reporting | feat(reporting): add Reliable Reporting pipelines (#7228) |

### Cross-module commits against the declared module DAG (substantive, caps split)

| relation | commits |
|---|---|
| all pairs on one dependency path | 149 |
| some pairs unrelated | 32 |
| no pair related | 7 |

Commits with a non-additive change in a module and a change in a module that depends on it: 89.

| module A | module B | relation | commits |
|---|---|---|---|
| module:buying | module:creative | dependency | 65 |
| module:buying | module:media-vocabulary | dependency | 44 |
| module:buying | module:signals | dependency | 39 |
| module:accounts | module:buying | dependency | 29 |
| module:buying | module:governance | dependency | 28 |
| module:buying | module:identity | dependency | 22 |
| module:creative | module:governance | dependency | 21 |
| module:accounts | module:creative | dependency | 19 |
| module:creative | module:identity | dependency | 18 |
| module:buying | module:reporting | dependency | 17 |
| module:creative | module:signals | dependency | 17 |
| module:accounts | module:governance | dependency | 17 |
| module:buying | module:compliance-testing | dependency | 14 |
| module:media-vocabulary | module:signals | dependency | 13 |
| module:accounts | module:signals | unrelated | 13 |

## Capabilities response as fragments

164 file changes in 164 commits (20% of schema commits). Fragment owners touched per change: 1: 133, 2: 19, 3+: 12.

| owner module | substantive caps changes |
|---|---|
| module:buying | 52 |
| kernel | 22 |
| module:creative | 20 |
| module:accounts | 14 |
| module:governance | 12 |
| module:signals | 10 |
| extension:request-signing-rfc9421 | 10 |
| module:compliance-testing | 6 |
| extension:webhook-signing | 5 |
| module:media-vocabulary | 5 |
| module:identity | 3 |
| module:reporting | 3 |
| module:sponsored-intelligence | 1 |

## Releases: what an implementer saw

| view | 2.5 line (1 GA) | 3.0 line (29 GA) | 3.1 line (30 GA) | 3.2 line (5 GA) | all |
|---|---|---|---|---|---|
| GA releases | 1 | 29 | 30 | 5 | 65 |
| …with any non-annotation schema change | 1 | 10 | 12 | 2 | 25 |
| …with a kernel change | 1 | 4 | 1 | 2 | 8 |
| …with a non-additive kernel change | 0 | 3 | 1 | 2 | 6 |
| module:accounts: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:accounts: module changed | 0 | 3 | 1 | 2 | 6 |
| module:buying: module or kernel changed | 1 | 5 | 8 | 2 | 16 |
| module:buying: module changed | 1 | 3 | 8 | 2 | 14 |
| module:compliance-testing: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:compliance-testing: module changed | 0 | 2 | 1 | 1 | 4 |
| module:creative: module or kernel changed | 1 | 5 | 5 | 2 | 13 |
| module:creative: module changed | 1 | 3 | 5 | 1 | 10 |
| module:governance: module or kernel changed | 1 | 5 | 2 | 2 | 10 |
| module:governance: module changed | 0 | 3 | 2 | 1 | 6 |
| module:identity: module or kernel changed | 1 | 5 | 1 | 2 | 9 |
| module:identity: module changed | 0 | 2 | 1 | 1 | 4 |
| module:media-vocabulary: module or kernel changed | 1 | 4 | 2 | 2 | 9 |
| module:media-vocabulary: module changed | 0 | 1 | 2 | 1 | 4 |
| module:reporting: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:reporting: module changed | 0 | 1 | 1 | 2 | 4 |
| module:signals: module or kernel changed | 1 | 4 | 2 | 2 | 9 |
| module:signals: module changed | 0 | 1 | 2 | 1 | 4 |
| module:sponsored-intelligence: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:sponsored-intelligence: module changed | 0 | 1 | 1 | 0 | 2 |
| module:trusted-match: module or kernel changed | 1 | 6 | 3 | 2 | 12 |
| module:trusted-match: module changed | 0 | 5 | 3 | 1 | 9 |
| extension:aao-verification-token: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| extension:aao-verification-token: module changed | 0 | 0 | 0 | 1 | 1 |
| extension:adcp-ext-namespace: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| extension:adcp-ext-namespace: module changed | 0 | 0 | 0 | 0 | 0 |
| extension:request-signing-rfc9421: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| extension:request-signing-rfc9421: module changed | 0 | 0 | 1 | 1 | 2 |
| extension:response-signing-jws: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| extension:response-signing-jws: module changed | 0 | 0 | 1 | 0 | 1 |
| extension:spot-lifecycle: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| extension:spot-lifecycle: module changed | 0 | 0 | 0 | 0 | 0 |
| extension:webhook-signing: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| extension:webhook-signing: module changed | 0 | 0 | 0 | 1 | 1 |

## Experimental surfaces

| surface | file changes | non-add | additive | annot. |
|---|---|---|---|---|
| experimental file | 514 | 108 | 247 | 159 |
| stable file | 4514 | 809 | 2311 | 1394 |

Records by node marking (node or an ancestor carries x-status: experimental):

| surface | non-add rec | additive rec | annot. rec |
|---|---|---|---|
| exp-marked node | 229 | 575 | 398 |
| stable node | 1461 | 4357 | 3687 |

Experimental-file share by layer:

| layer | file changes | on experimental files | non-add fc | non-add on experimental files |
|---|---|---|---|---|
| kernel | 307 | 0 | 27 | 0 |
| module | 4110 | 513 | 820 | 108 |
| extension | 4 | 1 | 0 | 0 |
| assembly | 602 | 0 | 70 | 0 |
| retire | 5 | 0 | 0 | 0 |

Schema files at head: 1040; with schema-level x-status experimental: 125.

| window | file changes | on experimental files | non-add fc | non-add on exp. files | distinct files | distinct exp. files |
|---|---|---|---|---|---|---|
| pre-3.0 | 2002 | 206 (10%) | 436 | 35 (8%) | 508 | 39 |
| 3.0->3.1 | 1184 | 95 (8%) | 193 | 19 (10%) | 420 | 42 |
| 3.1->3.2 | 1564 | 188 (12%) | 242 | 50 (21%) | 647 | 91 |
| 3.2->now | 278 | 25 (9%) | 46 | 4 (9%) | 170 | 18 |

## Placement fallbacks

29 historical paths were not in the placement file after following renames; see unplaced.csv. Sources: dir-heuristic 14, referrers 15.

