# Secretariat Panel — Seats

The Secretariat reviews with a seated panel, not a single voice. Seats are the
expert roles in `.agents/roles/` (short checker variants for review/triage;
`-deep` advisors for RFCs and open-ended design). The **chair** is the desk
running the session (Argus on a PR, the triage routine on an issue): it selects
seats, runs them as one parallel batch, synthesizes by severity, and records
dissent.

## Seat selection

`code-reviewer` is mandatory on every source-code change (see the Argus prompt's
skip-everything list for the only exceptions). Domain seats stack on top:

| Trigger (PR files or issue scope) | Required seats |
|---|---|
| `static/schemas/source/**` | ad-tech-protocol-expert |
| `docs/reference/**`, `mintlify-docs/reference/**` | ad-tech-protocol-expert + docs-expert |
| Auth / tenant filters / credentials / MCP-A2A inputs / LLM-context paths | security-reviewer |
| New or renamed MCP tool / A2A skill | agentic-product-architect + ad-tech-protocol-expert |
| Error codes / `error-code.json` | ad-tech-protocol-expert |
| DB migrations | code-reviewer (backfill + tenant-scoping focus) |
| Audit walker / CI gates / spec-build pipeline | ad-tech-protocol-expert + code-reviewer |
| Creative format specs | ad-creative-expert |
| Buy-side / sell-side workflow | adtech-product-expert |
| Signals / audience / targeting semantics | ad-tech-protocol-expert + adtech-product-expert |
| Compliance suite / storyboards | ad-tech-protocol-expert + code-reviewer |
| Registry / discovery (`brand.json`, `adagents.json`) | ad-tech-protocol-expert + adtech-product-expert |
| SDK / client-facing DX | dx-expert or javascript-protocol-expert |
| Education / Sage / certification | education-expert |
| Admin / ops tooling | internal-tools-strategist + dx-expert |
| Web / site / non-normative docs | docs-expert (+ copywriter or css-expert if front-end) |
| Data / analytics | data-analyst |
| Agent prompts / routines / `.agents/**` | prompt-engineer + security-reviewer |

Use fewer seats when the change is narrow (one bug in one file). Use the full
relevant panel for RFCs, architecture, and cross-cutting changes — and prefer
`-deep` advisor variants there.

## Chair rules

- Run all selected seats as a **single parallel batch**; never sequentially.
- Give each seat the artifact reference (PR number / issue number) and a
  one-line "what to evaluate."
- **Synthesize by severity, not volume.** One security-reviewer High with a
  named `file:line` and an attack path outweighs twenty style nits.
- A seat verdict naming a MUST FIX category (security High, spec drift,
  blocker, breaking contract without `major`) flows through to a block — the
  chair does not override it without naming a specific reason.
- `sound-with-caveats` verdicts become follow-ups, not blocks.
- **Record dissent.** If seats disagree after synthesis, the memo carries both
  positions crisply — a panel that always agrees is a single reviewer with
  extra steps. Unresolved dissent on a Normative+ question escalates per the
  constitution.
