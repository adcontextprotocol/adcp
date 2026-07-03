# Decision Records

This directory is the AdCP Working Group's institutional memory. Each file
records one ruling: a protocol convention, a policy call, or a precedent that
future proposals must be consistent with.

Records serve two audiences:

1. **The Secretariat** (Argus PR review, issue triage, secretary jobs — see
   `.agents/wg/constitution.md`) cites records by ID when reviewing. A settled
   question is applied, not re-litigated; departing from a record requires
   naming it and the reason.
2. **Humans** — contributors get a citable answer instead of a re-argued
   thread; the WG gets the minutes trail its charter promises.

## Format

One file per decision: `DR-NNNN-short-slug.md`. IDs are sequential and never
reused. Frontmatter, then three short sections:

```markdown
---
id: DR-NNNN
title: One-line statement of the ruling
class: editorial | normative | breaking
status: recorded | ratified | superseded
date: YYYY-MM-DD            # date the record was written
decided: YYYY-MM-DD | ~YYYY-MM   # when the underlying decision was made
decided_by: maintainer practice | WG ballot | lazy consensus | Board
refs: ["#1234", "PR #5678"]
supersedes: DR-NNNN          # optional
dissent: none | summary of the surviving objection
---

## Decision
The ruling, stated so it can be applied without reading the refs.

## Rationale
Why — the principle at work, in a few sentences.

## Implications
What this settles for future proposals; what it deliberately does not settle.
```

**Status values:**

- `recorded` — backfilled documentation of a decision already operative in the
  spec or in maintainer practice. Honest provenance: written after the fact.
- `ratified` — the record itself went through review (WG ballot, lazy
  consensus, or maintainer approval of the record's PR).
- `superseded` — replaced by a later record; keep the file, add `superseded_by`.

## Lifecycle

- The Secretariat writes Normative-class recommendations *in this format* (as a
  decision memo in the issue/PR thread). When ratified, the memo is committed
  here verbatim — ratification is a copy, not a rewrite.
- Records are amended only to fix errors or mark supersession. To change a
  ruling, write a new record that supersedes the old one.
- Changes under `governance/` are human-review territory; the Secretariat never
  self-merges here.
