---
---

Calibrate Addie's response shape based on prod-corpus measurement:

- **Voice section in identity.md**: shortest answer with the most information,
  but explainers ("what is X?", "how is X different from Y?", architectural
  walkthroughs) go long without apology. Length is fitness-for-purpose, not
  a virtue in either direction.
- **response-style.md aligned to the Voice rule**: explainer questions get
  their own row in the word-count table (200–500 words is normal, longer
  fine when depth is the point). Sharp transactional questions still get
  the tight cap. The "What is X is a paragraph" rule that contradicted the
  policy is removed.
- **Code-block content excluded from response word count** in the shape
  grader. A "draw a mermaid diagram of X" question legitimately produces a
  long fenced code block; counting code as words tripped length_cap blow-out
  when no actual prose was verbose. Inline backtick code stays counted.
- **Two new manual eval scripts** for inspecting prod shape behavior:
  - `shadow-eval-prod-summary.ts` — pulls flagged threads via the admin
    API, filters to `shadow_eval_status='complete'`, prints source split,
    knowledge-gap rate, shape-violation buckets, word/ratio distributions.
  - `shape-eval-prod-sample.ts` — uniform random sample of (user → assistant)
    pairs from recent threads (one per thread for independence). Runs the
    shape grader locally, prints prevalence rates that ARE meaningful as
    global rates (unlike the human-intervened corpora). N=100 baseline:
    median ratio 1.07, P90 = 2.18x, length_cap ~60% (largely driven by
    explainer questions which the new Voice rule explicitly allows).

Both scripts use ADMIN_API_KEY (Bearer) — same env var the redteam runner
uses. Not in CI.
