---
---

Render shape regressions and source-distinct labeling on the admin-addie
shadow eval panel:

- Pill-style badges for `shadow_eval_shape` violations on both Addie's
  response and the longest human reply (length_cap, default_template,
  structured_heavy, comprehensive_dump, signin_opener, ritual:phrase),
  with response word counts and ratio-to-expected.
- Distinct panel header per `shadow_eval_source`: "Corrected Capture" for
  threads where Addie posted and a human corrected, "Shadow Evaluation"
  for the suppression case where Addie was kept silent.
- Caveat line: "Corpus is selected for human intervention — counts here
  are not a global rate." Prevents reviewers from miscomputing prevalence
  from the corrected-capture corpus.
- Side-by-side comparison label switches from "ADDIE WOULD HAVE SAID" to
  "ADDIE'S ACTUAL RESPONSE" when source is corrected-capture (the field
  holds her real reply, not a re-generated shadow).

API path unchanged — `/api/admin/addie/threads/:id` already returns the
full thread context, so the new fields are exposed without server work.
