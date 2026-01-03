---
---

Consolidate rating system to thumbs up/down and add rating_source to distinguish user vs admin feedback.

Add eval framework for testing rule changes against historical interactions:
- New tables: addie_eval_runs, addie_eval_results
- Re-execute historical messages with proposed rules using real Claude calls
- Compare original vs new responses (routing, tools, response text)
- Human review with verdicts (improved/same/worse/uncertain)
- API endpoints: POST/GET /api/admin/addie/eval/runs, GET /results, PUT /review
