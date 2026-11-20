| metric | cut-11 | cut-29 | coarse | balanced | buying-core | buying-delivery |
|---|---|---|---|---|---|---|
| post-GA file changes in the kernel | 18.2% | 6.5% | 6.5% | 6.5% | 6.5% | 6.5% |
| post-GA non-additive file changes in the kernel | 6.7% | 3.1% | 3.1% | 3.1% | 3.1% | 3.1% |
| commits touching 2+ modules, all windows (with sweeps) | 209 (34.2%) | 247 (40.4%) | 188 (30.8%) | 221 (36.2%) | 199 (32.6%) | 188 (30.8%) |
| …without sweeps | 196 (32.8%) | 234 (39.1%) | 175 (29.3%) | 208 (34.8%) | 186 (31.1%) | 175 (29.3%) |
| …post-GA without sweeps | 114 (29.0%) | 140 (35.6%) | 96 (24.4%) | 120 (30.5%) | 104 (26.5%) | 96 (24.4%) |
| …post-GA without sweeps or compliance-testing | 26.2% | 33.3% | 20.9% | 27.2% | 22.9% | 21.1% |
| commits touching 5+ modules, all windows (with sweeps) | 18 | 42 | 15 | 27 | 20 | 19 |
| …post-GA without sweeps | 3 | 14 | 1 | 6 | 5 | 4 |
| post-GA pair incidences off the dependency DAG | 16/245 | 75/456 | 25/162 | 40/282 | 36/205 | 35/187 |
| GA releases with a kernel change | 10 | 8 | 8 | 8 | 8 | 8 |
| governance: releases changed / +kernel / +deps | 5 / 11 / 20 | 6 / 10 / 21 | 6 / 10 / 21 | 6 / 10 / 21 | 6 / 10 / 21 | 6 / 10 / 21 |
| signals: releases changed / +kernel / +deps | 4 / 11 / 4 | 4 / 9 / 12 | 4 / 9 / 8 | 4 / 9 / 5 | 4 / 9 / 5 | 4 / 9 / 5 |
| creative/formats: releases changed / +kernel / +deps | 11 / 15 / 13 | 10 / 13 / 13 | 10 / 13 / 14 | 10 / 13 / 14 | 10 / 13 / 14 | 10 / 13 / 14 |
| buying: releases changed / +kernel / +deps | 14 / 18 / 19 | 13 / 15 / 20 | 14 / 16 / 20 | 13 / 15 / 20 | 13 / 15 / 20 | 14 / 16 / 20 |
| accounts/onboarding: releases changed / +kernel / +deps | 6 / 10 / 6 | 5 / 8 / 5 | 7 / 9 / 7 | 6 / 8 / 6 | 6 / 8 / 6 | 6 / 8 / 6 |
| reporting: releases changed / +kernel / +deps | 9 / 14 / 19 | 5 / 9 / 20 | 14 / 16 / 20 | 5 / 9 / 20 | 5 / 9 / 20 | 4 / 8 / 20 |

Sweep threshold sensitivity, post-GA cross-module share without sweeps:

| N | sweeps (all windows) | cut-11 | cut-29 | coarse | balanced | buying-core | buying-delivery |
|---|---|---|---|---|---|---|---|
| 6 | 18 | 29.0% | 35.6% | 24.4% | 30.5% | 26.5% | 24.4% |
| 8 | 13 | 29.0% | 35.6% | 24.4% | 30.5% | 26.5% | 24.4% |
| 12 | 6 | 29.2% | 35.8% | 24.6% | 30.7% | 26.6% | 24.6% |
