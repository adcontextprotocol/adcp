---
"adcontextprotocol": minor
---

spec(compliance): pin endpoint_pattern wildcard grammar + downgrade non-JSON match modes to not_applicable (closes #3845)

Two implementation-surfaced ambiguities from runner-side adoption of #3816 (the anti-façade + cascade-attribution contract). Both are minor-but-load-bearing pins that affect cross-runner determinism on the same storyboard.

**1. `endpoint_pattern` wildcard grammar.** `comply-test-controller-request.json` previously described `endpoint_pattern` as a "glob-style pattern" with no normative grammar. The `@adcp/sdk` runner picks the most permissive interpretation (`*` matches `/`-crossing, all other regex metacharacters escaped literally). A different runner could legitimately read "glob-style" and ship POSIX glob semantics where `*` doesn't cross `/` and `?` is single-char-any — same storyboard, different verdict. Pinned: `*` matches zero or more characters of any kind including `/`. No other characters have wildcard semantics — `?` is a literal question mark, `[`/`]` are literal brackets. Implementations MUST anchor the pattern (full-string match). Renamed "glob-style" → "wildcard" in the description so the grammar's intentional narrowness is obvious from the noun.

**2. Non-JSON `payload_must_contain` match modes downgrade to `not_applicable`.** The earlier comment in `storyboard-schema.yaml` said the runner "falls back to substring matching for `match: present`" against non-JSON payloads (form-urlencoded, multipart, plain text). The `@adcp/sdk` runner implemented this as a terminal-key heuristic (extract `hashed_email` from `users[*].hashed_email`, substring-search the raw payload string). That creates false positives: a payload mentioning `hashed_email` anywhere — URL fragment, comment, unrelated metadata field — would pass the assertion. For an anti-façade contract specifically, false positives are exactly what lets façades pass.

Per the option-(b) decision in #3845: ALL `payload_must_contain` match modes (`present` / `equals` / `contains_any`) now grade `not_applicable` against non-JSON `content_type`. Storyboards that need a "the upstream call carried this value" signal against non-JSON payloads use `identifier_paths` instead — that surface substring-searches storyboard-supplied VALUES (not path-derived strings), which is encoding-agnostic and doesn't suffer the false-positive surface.

**Why both belong in spec, not runner docs.** #3816 explicitly framed itself as the load-bearing anti-façade contract that distinguishes a real adapter from a façade. Two compliant runners grading the same storyboard differently against the same agent (because of unspecified wildcard / substring semantics) means adopters can game whichever runner is more permissive. Pinning these is small but the divergence cost is high.

**Cross-link:** SDK PR `adcontextprotocol/adcp-client#1289` is the runner-side adoption that surfaced both ambiguities; runner needs a follow-up alignment to drop the terminal-key fallback now that the spec downgrades non-JSON matches to `not_applicable`.
