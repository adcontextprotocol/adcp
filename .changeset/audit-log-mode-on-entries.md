---
"adcontextprotocol": patch
---

Add optional `mode` field to `get_plan_audit_logs` audit entries, recording the governance mode (enforce/advisory/audit) active at check time. Surfaces the enforcement posture that produced each decision, closing a gap where audit and enforce modes produced identical-looking trails.
