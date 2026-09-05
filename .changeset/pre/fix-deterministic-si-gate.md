---
"adcontextprotocol": patch
---

Gate the deterministic SI session follow-up steps on `si_initiate_session` so
agents outside the sponsored intelligence domain cascade-skip the phase instead
of receiving a false `si_send_message` failure. Reported in adcp-client#2827.
