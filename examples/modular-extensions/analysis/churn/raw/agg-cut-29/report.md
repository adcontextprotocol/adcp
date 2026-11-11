# Schema churn report

Head `45591e97b3`, first-parent since 2025-10-19, placement `../kernel-cut/raw/placement2.json`.

Commits touching schemas (excluding the bootstrap commit): 839. File changes: 5028.

Placement source: placement 4841, placement-via-rename 111, dir-heuristic 43, referrers 33

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
| module:products | module | 228 | 67 | 587 | 100 | 346 | 141 | 640 | 202 | 449 | 129 |
| module:formats | module | 113 | 35 | 451 | 74 | 262 | 115 | 554 | 199 | 334 | 138 |
| module:media-buy | module | 152 | 44 | 445 | 99 | 221 | 125 | 453 | 165 | 341 | 55 |
| module:creative | module | 129 | 52 | 445 | 118 | 200 | 127 | 469 | 199 | 393 | 81 |
| module:governance-lists | module | 36 | 10 | 197 | 39 | 109 | 49 | 140 | 58 | 66 | 41 |
| module:campaign-governance | module | 47 | 17 | 167 | 39 | 76 | 52 | 209 | 98 | 132 | 25 |
| module:inventory | module | 55 | 9 | 129 | 18 | 77 | 34 | 119 | 26 | 95 | 45 |
| module:signals | module | 54 | 22 | 126 | 33 | 57 | 36 | 140 | 51 | 107 | 25 |
| module:delivery-reporting | module | 68 | 13 | 123 | 17 | 75 | 31 | 216 | 24 | 96 | 18 |
| module:proposal-negotiation | module | 36 | 14 | 113 | 21 | 56 | 36 | 97 | 43 | 59 | 37 |
| module:account | module | 53 | 11 | 109 | 15 | 58 | 36 | 87 | 28 | 87 | 22 |
| module:brand | module | 64 | 17 | 105 | 26 | 61 | 18 | 202 | 42 | 124 | 22 |
| module:metrics | module | 48 | 7 | 105 | 8 | 67 | 30 | 103 | 9 | 72 | 32 |
| module:targeting | module | 39 | 7 | 105 | 8 | 88 | 9 | 131 | 14 | 52 | 69 |
| module:reliable-reporting | module | 16 | 8 | 105 | 22 | 63 | 20 | 119 | 42 | 78 | 50 |
| module:audiences-events | module | 39 | 10 | 100 | 19 | 52 | 29 | 72 | 26 | 53 | 26 |
| module:content-standards | module | 25 | 11 | 97 | 34 | 51 | 12 | 69 | 58 | 31 | 17 |
| module:compliance-testing | module | 61 | 28 | 91 | 32 | 33 | 26 | 120 | 58 | 108 | 4 |
| module:trusted-match | module | 35 | 16 | 91 | 32 | 30 | 29 | 64 | 65 | 74 | 16 |
| module:sponsored-intelligence | module | 17 | 4 | 84 | 10 | 48 | 26 | 60 | 12 | 38 | 20 |
| module:catalogs | module | 32 | 14 | 82 | 17 | 46 | 19 | 67 | 25 | 54 | 32 |
| module:account-onboarding | module | 42 | 11 | 62 | 13 | 22 | 27 | 56 | 26 | 75 | 6 |
| module:brand-rights | module | 18 | 5 | 58 | 10 | 25 | 23 | 30 | 22 | 36 | 11 |
| module:notifications | module | 18 | 4 | 35 | 5 | 17 | 13 | 28 | 6 | 27 | 11 |
| module:measurement | module | 21 | 6 | 31 | 6 | 17 | 8 | 32 | 13 | 25 | 6 |
| module:policy | module | 7 | 2 | 27 | 2 | 19 | 6 | 25 | 3 | 20 | 14 |
| module:principal | module | 4 | 1 | 18 | 2 | 12 | 4 | 15 | 2 | 20 | 9 |
| module:agent-trust | module | 8 | 1 | 13 | 1 | 9 | 3 | 9 | 1 | 10 | 9 |
| module:account-change-feed | module | 4 | 0 | 9 | 0 | 5 | 4 | 6 | 0 | 13 | 4 |
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
| module:products | module | 213 (48) | 100 (17) | 233 (30) | 41 (5) |
| module:formats | module | 181 (44) | 115 (15) | 137 (14) | 18 (1) |
| module:media-buy | module | 169 (46) | 97 (16) | 166 (35) | 13 (2) |
| module:creative | module | 202 (66) | 94 (20) | 126 (26) | 23 (6) |
| module:governance-lists | module | 137 (25) | 46 (11) | 11 (3) | 3 (0) |
| module:campaign-governance | module | 98 (21) | 35 (8) | 31 (10) | 3 (0) |
| module:inventory | module | 56 (12) | 28 (3) | 31 (2) | 14 (1) |
| module:signals | module | 56 (14) | 52 (14) | 12 (2) | 6 (3) |
| module:delivery-reporting | module | 33 (7) | 23 (4) | 51 (5) | 16 (1) |
| module:proposal-negotiation | module | 7 (1) | 2 (0) | 63 (8) | 41 (12) |
| module:account | module | 50 (10) | 31 (5) | 28 (0) | 0 (0) |
| module:brand | module | 57 (17) | 31 (9) | 11 (0) | 6 (0) |
| module:metrics | module | 28 (4) | 32 (1) | 39 (2) | 6 (1) |
| module:targeting | module | 31 (3) | 21 (2) | 49 (2) | 4 (1) |
| module:reliable-reporting | module | 0 (0) | 0 (0) | 99 (20) | 6 (2) |
| module:audiences-events | module | 55 (12) | 19 (5) | 20 (2) | 6 (0) |
| module:content-standards | module | 73 (27) | 24 (7) | 0 (0) | 0 (0) |
| module:compliance-testing | module | 8 (2) | 40 (16) | 40 (13) | 3 (1) |
| module:trusted-match | module | 32 (8) | 24 (6) | 34 (18) | 1 (0) |
| module:sponsored-intelligence | module | 62 (6) | 22 (4) | 0 (0) | 0 (0) |
| module:catalogs | module | 56 (11) | 9 (4) | 14 (2) | 3 (0) |
| module:account-onboarding | module | 23 (5) | 22 (3) | 14 (5) | 3 (0) |
| module:brand-rights | module | 37 (5) | 15 (3) | 6 (2) | 0 (0) |
| module:notifications | module | 0 (0) | 11 (0) | 22 (4) | 2 (1) |
| module:measurement | module | 14 (4) | 6 (1) | 11 (1) | 0 (0) |
| module:policy | module | 19 (2) | 0 (0) | 8 (0) | 0 (0) |
| module:principal | module | 0 (0) | 0 (0) | 18 (2) | 0 (0) |
| module:agent-trust | module | 1 (0) | 1 (0) | 5 (0) | 6 (1) |
| module:account-change-feed | module | 0 (0) | 0 (0) | 7 (0) | 2 (0) |
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
| single-module | 402 | – |
| aggregator-only | 76 | 17% |
| kernel-internal | 0 | 0% |
| kernel+one-module | 33 | 8% |
| cross-module | 328 | 75% |
| total | 839 |  |

Cross-module commits by number of non-kernel modules: 2: 160, 3: 72, 4: 38, 5: 21, 6+: 37


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:media-buy | module:products | 79 |
| module:creative | module:media-buy | 52 |
| module:creative | module:formats | 48 |
| module:creative | module:products | 46 |
| module:delivery-reporting | module:products | 39 |
| module:delivery-reporting | module:media-buy | 35 |
| module:formats | module:products | 35 |
| module:inventory | module:products | 34 |
| module:products | module:targeting | 32 |
| module:products | module:signals | 31 |
| module:account | module:account-onboarding | 31 |
| module:metrics | module:products | 28 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 87 | 30 | 0 | 9 | 126 |
| 3.0->3.1 | 173 | 22 | 0 | 12 | 81 |
| 3.1->3.2 | 119 | 20 | 0 | 7 | 89 |
| 3.2->now | 23 | 4 | 0 | 5 | 32 |

### all|caps-split

| category | commits | share of multi-module |
|---|---|---|
| single-module | 402 | – |
| aggregator-only | 58 | 13% |
| kernel-internal | 0 | 0% |
| kernel+one-module | 36 | 8% |
| cross-module | 343 | 78% |
| total | 839 |  |

Cross-module commits by number of non-kernel modules: 2: 156, 3: 79, 4: 43, 5: 25, 6+: 40


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:media-buy | module:products | 98 |
| module:creative | module:media-buy | 56 |
| module:creative | module:formats | 48 |
| module:creative | module:products | 46 |
| module:delivery-reporting | module:products | 40 |
| module:delivery-reporting | module:media-buy | 38 |
| module:formats | module:products | 35 |
| module:inventory | module:products | 34 |
| module:products | module:targeting | 33 |
| module:account | module:account-onboarding | 32 |
| module:products | module:signals | 31 |
| module:metrics | module:products | 30 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 87 | 20 | 0 | 10 | 135 |
| 3.0->3.1 | 173 | 19 | 0 | 14 | 82 |
| 3.1->3.2 | 119 | 15 | 0 | 8 | 93 |
| 3.2->now | 23 | 4 | 0 | 4 | 33 |

### substantive|caps-as-aggregator

| category | commits | share of multi-module |
|---|---|---|
| single-module | 319 | – |
| aggregator-only | 42 | 14% |
| kernel-internal | 0 | 0% |
| kernel+one-module | 19 | 7% |
| cross-module | 231 | 79% |
| total | 611 |  |

Cross-module commits by number of non-kernel modules: 2: 118, 3: 51, 4: 24, 5: 13, 6+: 25


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:media-buy | module:products | 50 |
| module:creative | module:formats | 38 |
| module:creative | module:media-buy | 35 |
| module:creative | module:products | 32 |
| module:delivery-reporting | module:products | 31 |
| module:formats | module:products | 28 |
| module:products | module:targeting | 27 |
| module:delivery-reporting | module:media-buy | 23 |
| module:inventory | module:products | 23 |
| module:products | module:signals | 21 |
| module:account | module:account-onboarding | 18 |
| module:formats | module:media-buy | 17 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 95 | 13 | 0 | 10 | 96 |
| 3.0->3.1 | 111 | 14 | 0 | 4 | 52 |
| 3.1->3.2 | 88 | 11 | 0 | 4 | 63 |
| 3.2->now | 25 | 4 | 0 | 1 | 20 |

### substantive|caps-split

| category | commits | share of multi-module |
|---|---|---|
| single-module | 319 | – |
| aggregator-only | 25 | 9% |
| kernel-internal | 1 | 0% |
| kernel+one-module | 21 | 7% |
| cross-module | 245 | 84% |
| total | 611 |  |

Cross-module commits by number of non-kernel modules: 2: 113, 3: 61, 4: 29, 5: 15, 6+: 27


Top non-kernel module pairs:

| module A | module B | commits |
|---|---|---|
| module:media-buy | module:products | 68 |
| module:creative | module:formats | 38 |
| module:creative | module:media-buy | 38 |
| module:creative | module:products | 32 |
| module:delivery-reporting | module:products | 31 |
| module:formats | module:products | 28 |
| module:products | module:targeting | 28 |
| module:delivery-reporting | module:media-buy | 25 |
| module:inventory | module:products | 23 |
| module:products | module:signals | 21 |
| module:media-buy | module:targeting | 20 |
| module:formats | module:media-buy | 19 |

By window:

| window | single-module | aggregator-only | kernel-internal | kernel+one-module | cross-module |
|---|---|---|---|---|---|
| pre-3.0 | 95 | 4 | 1 | 11 | 103 |
| 3.0->3.1 | 111 | 13 | 0 | 5 | 52 |
| 3.1->3.2 | 88 | 6 | 0 | 4 | 68 |
| 3.2->now | 25 | 2 | 0 | 1 | 22 |

Broad cross-module commits (5+ non-kernel modules): 42

| sha | PR | window | modules | subject |
|---|---|---|---|---|
| 1d705a2996 | 241 | pre-3.0 | kernel module:creative module:delivery-reporting module:formats module:inventory module:measurement module:media-buy module:products module:signals | Add extension and context fields to AdCP schemas (#241) |
| 309a8807f5 | 646 | pre-3.0 | kernel kernel-types module:brand module:catalogs module:creative module:delivery-reporting module:formats module:inventory module:measurement module:media-buy module:metrics module:products module:signals module:targeting | Allow additional properties in all JSON schemas for forward compatibility (#646) |
| f4ef555547 | 859 | pre-3.0 | kernel kernel-types module:brand module:catalogs module:content-standards module:creative module:formats module:governance-lists module:inventory module:media-buy module:products module:proposal-negotiation module:sponsored-intelligence module:targeting | Release AdCP v3.0.0-beta.1 (#859) |
| 34ece9fa12 | 980 | pre-3.0 | module:audiences-events module:delivery-reporting module:media-buy module:metrics module:products | feat(schema): Add conversion tracking (sync_event_sources, log_event) (#980) |
| 96a90ec236 | 997 | pre-3.0 | kernel kernel-types module:account module:content-standards module:creative module:formats module:governance-lists module:products module:signals | feat: Standardize cursor-based pagination across all list operations (#997) |
| 37dbd0d2a6 | 986 | pre-3.0 | module:creative module:delivery-reporting module:formats module:metrics module:products | feat: Add creative delivery reporting and format-level metric declarations (#986) |
| 305b8ec234 | 1022 | pre-3.0 | kernel module:audiences-events module:content-standards module:creative module:delivery-reporting module:formats module:governance-lists module:inventory module:media-buy module:products module:signals | feat(schema): Add minItems: 1 to request-side arrays (#1018) (#1022) |
| 892da1df24 | 1113 | pre-3.0 | kernel-types module:brand module:catalogs module:creative module:formats module:governance-lists module:media-buy module:products module:sponsored-intelligence | feat!: Unify brand identity — delete brand-manifest.json, use brand refs (#1113) |
| 80afa9784c | 1119 | pre-3.0 | module:account module:account-onboarding module:audiences-events module:creative module:delivery-reporting module:formats module:measurement module:media-buy module:products module:signals | feat: add sandbox mode as protocol parameter on all tasks (#1119) |
| c782f665a8 | 1144 | pre-3.0 | kernel-types module:catalogs module:creative module:delivery-reporting module:formats module:media-buy module:products module:targeting | feat: first-class catalogs — unified data feeds with sync lifecycle, 12 catalog types, and |
| 142bcd596f | 1179 | pre-3.0 | kernel-types module:account module:account-onboarding module:audiences-events module:catalogs module:content-standards module:creative module:delivery-reporting module:media-buy module:products | docs: disclose seller auth model in get_adcp_capabilities (#1179) |
| 2b8d6b69bc | 1251 | pre-3.0 | kernel-types module:audiences-events module:media-buy module:metrics module:products module:targeting | feat(schema): refine frequency caps, pricing, identifiers, keyword capabilities, and durat |
| 544230b7ad | 1252 | pre-3.0 | kernel kernel-types module:account module:content-standards module:creative module:delivery-reporting module:governance-lists module:media-buy module:metrics module:products module:signals | feat(schema): address 17 schema gaps that block autonomous agent operation (#1252) |
| f5e6a210a0 | 1267 | pre-3.0 | module:audiences-events module:delivery-reporting module:media-buy module:products module:targeting | feat(schema): agent ergonomics improvements from #1240 (#1267) |
| 9c2a978c3a | 1351 | pre-3.0 | module:account module:account-onboarding module:campaign-governance module:content-standards module:media-buy module:policy module:products | feat: governance policy registry and campaign governance protocol (#1351) |
| 257463e7cd | 1593 | pre-3.0 | module:audiences-events module:brand module:campaign-governance module:media-buy module:policy module:signals | feat: structured audience data for bias/fairness governance (#1389) (#1593) |
| 5ecc29d0c0 | 1622 | pre-3.0 | kernel module:account module:audiences-events module:brand module:brand-rights module:campaign-governance module:content-standards module:creative module:delivery-reporting module:governance-lists module:measurement module:media-buy module:products module:signals module:sponsored-intelligence | feat!: seller-assigned IDs, opaque governance context, explicit idempotency (#1622) |
| 63a33b4935 | 1642 | pre-3.0 | module:brand module:creative module:formats module:inventory module:products | feat: collection/installment model, deadlines, and print channel support (#1642) |
| 7736865ac1 | 1959 | pre-3.0 | kernel module:account module:account-onboarding module:audiences-events module:brand module:brand-rights module:campaign-governance module:catalogs module:content-standards module:creative module:delivery-reporting module:formats module:governance-lists module:measurement module:media-buy module:products module:signals module:sponsored-intelligence module:trusted-match | feat: per-request version declaration (adcp_major_version) (#1959) |
| 7086cc2ba7 | 1937 | pre-3.0 | kernel-types module:account module:content-standards module:creative module:formats module:governance-lists | feat: unified vendor pricing for creative, governance, and property lists (#1937) |
| 63dba34c8f | 2046 | pre-3.0 | module:creative module:delivery-reporting module:formats module:media-buy module:metrics module:products | feat: broadcast TV support for 3.0 (#2046) |
| b674082efe | 2194 | pre-3.0 | kernel module:campaign-governance module:compliance-testing module:content-standards module:governance-lists module:signals module:sponsored-intelligence | feat: GOVERNANCE_DENIED error, flatten comply_test_controller, context/ext, require signal |
| 204fe595f3 | 2322 | pre-3.0 | module:campaign-governance module:content-standards module:creative module:governance-lists module:inventory module:policy | spec: governance + validation + content-standards schema alignment for 3.0 GA (#2322) |
| 43586d69cc | 2315 | pre-3.0 | kernel module:account module:account-onboarding module:audiences-events module:brand module:brand-rights module:campaign-governance module:catalogs module:content-standards module:creative module:governance-lists module:measurement module:media-buy module:signals module:sponsored-intelligence | feat(schemas)!: require idempotency_key on all mutating requests (#2315) |
| feed616198 | 3174 | 3.0->3.1 | module:account module:campaign-governance module:content-standards module:creative module:formats module:governance-lists module:inventory module:products module:targeting | feat(schema): hoist 13 duplicate inline enum sets into shared enums/ definitions (#3174) |
| 6eadf0663c | 3493 | 3.0->3.1 | kernel module:account module:account-onboarding module:audiences-events module:brand module:brand-rights module:campaign-governance module:catalogs module:compliance-testing module:content-standards module:creative module:delivery-reporting module:formats module:governance-lists module:measurement module:media-buy module:products module:signals module:sponsored-intelligence module:trusted-match | spec(versioning): release-precision protocol version negotiation (#3493) |
| 9c087a2525 | 3307 | 3.0->3.1 | kernel kernel-types module:catalogs module:creative module:formats module:inventory module:products | feat(canonical-formats): AdCP 3.1 — 12 canonicals + publisher catalog + projection-ref + s |
| ca60b16ccf | 4896 | 3.0->3.1 | kernel module:account module:account-onboarding module:audiences-events module:brand module:brand-rights module:campaign-governance module:catalogs module:compliance-testing module:content-standards module:creative module:delivery-reporting module:formats module:governance-lists module:measurement module:media-buy module:products module:signals module:sponsored-intelligence module:trusted-match | spec: fold protocol-envelope into per-task response schemas (closes #4878) (#4896) |
| 2c5196bf3f | 5014 | 3.0->3.1 | kernel kernel-types module:creative module:formats module:inventory module:media-buy module:products | [codex] Add publisher placement and format refs (#5014) |
| dbc5b56172 |  | 3.0->3.1 | module:account module:compliance-testing module:formats module:metrics module:signals module:targeting | feat(schemas): improve SDK generation ergonomics |
| 72b79acf5b | 5394 | 3.0->3.1 | module:catalogs module:delivery-reporting module:media-buy module:products module:targeting | feat: add country-local postal systems (#5394) |
| 19fd2d566d | 6088 | 3.1->3.2 | kernel module:audiences-events module:delivery-reporting module:media-buy module:products module:proposal-negotiation | feat(media-buy): add shared budgets and bidding policy (#6088) |
| f36f565076 | 6125 | 3.1->3.2 | kernel-types module:brand-rights module:creative module:formats module:media-buy module:products module:trusted-match | feat(creative): make formats canonical in AdCP 3.2 (#6125) |
| 48ccce960c | 6218 | 3.1->3.2 | module:agent-trust module:audiences-events module:campaign-governance module:media-buy module:products module:signals | feat(schema): add portable attestations and audience evidence (#6218) |
| 3bdadda04a | 6095 | 3.1->3.2 | kernel-types module:account module:compliance-testing module:delivery-reporting module:metrics module:products | feat(media-buy): add revenue-share pricing (#6095) |
| 0bb862e076 | 6212 | 3.1->3.2 | extension:webhook-signing kernel kernel-types module:account module:campaign-governance module:catalogs module:compliance-testing module:creative module:formats module:inventory module:media-buy module:metrics module:notifications module:products module:proposal-negotiation module:targeting | feat(schema): add resource-scoped indicators and warnings (#6212) |
| 0eee9907c9 | 5990 | 3.1->3.2 | kernel-types module:account module:account-onboarding module:media-buy module:products module:proposal-negotiation | feat(media-buy): add aggregate and package daily budget caps (#5990) |
| a1672f9142 | 6794 | 3.1->3.2 | kernel module:campaign-governance module:media-buy module:policy module:products module:proposal-negotiation | feat(governance): add seller policy and change-right contracts (#6794) |
| 877f6a20a0 | 6966 | 3.1->3.2 | extension:request-signing-rfc9421 module:campaign-governance module:media-buy module:notifications module:principal module:reliable-reporting | feat(protocol): add agent configuration sync (#6966) |
| b7b6ba9171 | 6953 | 3.1->3.2 | extension:request-signing-rfc9421 extension:webhook-signing kernel module:account module:account-onboarding module:media-buy module:notifications module:products module:reliable-reporting | feat(reporting): add managed reporting status schemas (#6953) |
| dd6ab0bce3 | 7228 | 3.1->3.2 | extension:webhook-signing module:compliance-testing module:media-buy module:notifications module:reliable-reporting | feat(reporting): add Reliable Reporting pipelines (#7228) |
| 90d44780ef | 7946 | 3.2->now | kernel module:account-change-feed module:media-buy module:products module:proposal-negotiation module:reliable-reporting | fix(schema): compose version envelope in compact request and submitted schemas (#7946) |

### Cross-module commits against the declared module DAG (substantive, caps split)

| relation | commits |
|---|---|
| all pairs on one dependency path | 171 |
| some pairs unrelated | 68 |
| no pair related | 8 |

Commits with a non-additive change in a module and a change in a module that depends on it: 117.

| module A | module B | relation | commits |
|---|---|---|---|
| module:media-buy | module:products | dependency | 69 |
| module:creative | module:formats | dependency | 38 |
| module:creative | module:media-buy | dependency | 38 |
| module:creative | module:products | unrelated | 32 |
| module:delivery-reporting | module:products | dependency | 31 |
| module:formats | module:products | dependency | 28 |
| module:products | module:targeting | dependency | 28 |
| module:delivery-reporting | module:media-buy | dependency | 25 |
| module:inventory | module:products | dependency | 23 |
| module:products | module:signals | dependency | 23 |
| module:media-buy | module:targeting | dependency | 20 |
| module:formats | module:media-buy | dependency | 19 |
| module:account | module:products | dependency | 18 |
| module:audiences-events | module:products | dependency | 18 |
| module:account | module:account-onboarding | dependency | 18 |

## Capabilities response as fragments

164 file changes in 164 commits (20% of schema commits). Fragment owners touched per change: 1: 126, 2: 22, 3+: 16.

| owner module | substantive caps changes |
|---|---|
| module:media-buy | 40 |
| kernel | 22 |
| module:creative | 15 |
| module:products | 13 |
| module:account | 11 |
| extension:request-signing-rfc9421 | 10 |
| module:campaign-governance | 10 |
| module:audiences-events | 6 |
| module:compliance-testing | 6 |
| extension:webhook-signing | 5 |
| module:signals | 4 |
| module:proposal-negotiation | 4 |
| module:metrics | 4 |
| module:brand-rights | 3 |
| module:agent-trust | 3 |
| module:formats | 3 |
| module:content-standards | 2 |
| module:measurement | 2 |
| module:targeting | 2 |
| module:notifications | 2 |
| module:principal | 2 |
| module:sponsored-intelligence | 1 |
| module:delivery-reporting | 1 |
| module:account-change-feed | 1 |
| module:policy | 1 |
| module:reliable-reporting | 1 |

## Releases: what an implementer saw

| view | 2.5 line (1 GA) | 3.0 line (29 GA) | 3.1 line (30 GA) | 3.2 line (5 GA) | all |
|---|---|---|---|---|---|
| GA releases | 1 | 29 | 30 | 5 | 65 |
| …with any non-annotation schema change | 1 | 10 | 12 | 2 | 25 |
| …with a kernel change | 1 | 4 | 1 | 2 | 8 |
| …with a non-additive kernel change | 0 | 3 | 1 | 2 | 6 |
| module:account: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:account: module changed | 0 | 3 | 1 | 1 | 5 |
| module:account-change-feed: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:account-change-feed: module changed | 0 | 0 | 0 | 2 | 2 |
| module:account-onboarding: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:account-onboarding: module changed | 0 | 1 | 1 | 1 | 3 |
| module:agent-trust: module or kernel changed | 1 | 5 | 1 | 2 | 9 |
| module:agent-trust: module changed | 0 | 2 | 1 | 1 | 4 |
| module:audiences-events: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:audiences-events: module changed | 0 | 1 | 1 | 1 | 3 |
| module:brand: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:brand: module changed | 0 | 1 | 1 | 1 | 3 |
| module:brand-rights: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:brand-rights: module changed | 0 | 2 | 1 | 1 | 4 |
| module:campaign-governance: module or kernel changed | 1 | 5 | 2 | 2 | 10 |
| module:campaign-governance: module changed | 0 | 3 | 2 | 1 | 6 |
| module:catalogs: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:catalogs: module changed | 0 | 1 | 1 | 1 | 3 |
| module:compliance-testing: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:compliance-testing: module changed | 0 | 2 | 1 | 1 | 4 |
| module:content-standards: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:content-standards: module changed | 0 | 2 | 1 | 0 | 3 |
| module:creative: module or kernel changed | 1 | 4 | 2 | 2 | 9 |
| module:creative: module changed | 1 | 2 | 2 | 1 | 6 |
| module:delivery-reporting: module or kernel changed | 1 | 4 | 2 | 2 | 9 |
| module:delivery-reporting: module changed | 0 | 1 | 2 | 1 | 4 |
| module:formats: module or kernel changed | 1 | 5 | 4 | 2 | 12 |
| module:formats: module changed | 1 | 3 | 4 | 1 | 9 |
| module:governance-lists: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:governance-lists: module changed | 0 | 2 | 1 | 1 | 4 |
| module:inventory: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:inventory: module changed | 0 | 2 | 1 | 1 | 4 |
| module:measurement: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:measurement: module changed | 0 | 1 | 1 | 1 | 3 |
| module:media-buy: module or kernel changed | 1 | 5 | 2 | 2 | 10 |
| module:media-buy: module changed | 1 | 2 | 2 | 2 | 7 |
| module:metrics: module or kernel changed | 1 | 4 | 2 | 2 | 9 |
| module:metrics: module changed | 0 | 1 | 2 | 1 | 4 |
| module:notifications: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:notifications: module changed | 0 | 0 | 1 | 1 | 2 |
| module:policy: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:policy: module changed | 0 | 1 | 0 | 1 | 2 |
| module:principal: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:principal: module changed | 0 | 0 | 0 | 1 | 1 |
| module:products: module or kernel changed | 1 | 4 | 7 | 2 | 14 |
| module:products: module changed | 1 | 2 | 7 | 2 | 12 |
| module:proposal-negotiation: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:proposal-negotiation: module changed | 0 | 1 | 1 | 2 | 4 |
| module:reliable-reporting: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:reliable-reporting: module changed | 0 | 0 | 0 | 2 | 2 |
| module:signals: module or kernel changed | 1 | 4 | 2 | 2 | 9 |
| module:signals: module changed | 0 | 1 | 2 | 1 | 4 |
| module:sponsored-intelligence: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:sponsored-intelligence: module changed | 0 | 1 | 1 | 0 | 2 |
| module:targeting: module or kernel changed | 1 | 4 | 1 | 2 | 8 |
| module:targeting: module changed | 0 | 2 | 1 | 1 | 4 |
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

29 historical paths were not in the placement file after following renames; see unplaced.csv. Sources: dir-heuristic 15, referrers 14.

