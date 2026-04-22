---
---

spec(security): name and defend the cross-principal tool-call confusion threat

Ordinary prompt injection is in the threat model but the LLM-agent
version of the [confused-deputy](https://en.wikipedia.org/wiki/Confused_deputy_problem)
problem was not. A buyer agent typically holds credentials for many
principals at once — multiple sellers, multiple brand accounts inside
an agency agent. An LLM planning loop that exposes every one of those
tool surfaces to a single context lets a prompt injected in *seller X's*
response text drive a tool call against *seller Y's* endpoint or
*brand B's* account. The attacker never needs to hold the victim
principal's credentials — the victim's own agent does the work.

The server-side Layer 2 account scoping we already specify only
detects this when the target principal's account isn't in the buyer
agent's authorized set. When it is (which is the whole point of
agency and multi-seller agents), the seller sees a legitimate call.
This is the gap the changeset closes.

Adds two pieces:

- `security-model.mdx` §Threats specific to agentic advertising:
  expands the injection bullet into a dedicated **Cross-principal
  tool-call confusion** bullet, explaining why it differs from
  ordinary prompt injection (attacker uses *victim principal's*
  credentials without ever compromising them) and why the protocol
  layer alone cannot defend against it.

- `security.mdx` §Agent and Account Isolation: adds a
  **Client-side isolation: cross-principal tool-call confusion**
  subsection with four operator-side MUSTs:
    1. Tag every network-sourced string with its
       `{principal_domain, tool_name, response_field}` triple.
    2. Refuse cross-principal tool calls unless human-approved or
       explicitly policy-permitted; default is refuse.
    3. Segregate credential scopes: no single LLM context may hold
       live creds for principals whose interests can conflict.
    4. Log every cross-principal attempt, not just successes;
       refusal rate is the earliest injection-campaign signal.

No schema change. This threat lives on the client side of the wire,
so the spec's only legitimate role is to name it, explain why it's
distinct, and require the operator-level controls that actually
stop it.
