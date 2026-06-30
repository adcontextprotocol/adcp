---
"adcontextprotocol": patch
---

Apply residual prose cleanups to the `sponsored_context_accountability` storyboard: the `prerequisites.description` second paragraph and the `si_send_message_presentation_accepted` step narrative both still implied dynamic host-echo / different-identity substitution, contradicting the fixed Acme literal fixture the storyboard actually uses. Reword both spots to scope the prose to the static Acme fixture per @bokelley's #5551 review (2026-06-17 13:15 UTC).
