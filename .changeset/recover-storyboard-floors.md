---
"adcontextprotocol": patch
---

Re-baseline the storyboard conformance floors to the values measured on main's own CI run after the #6815 coverage rebaseline set them above reality (creative 48 clean/200 steps, creative-builder 48/172, sales 126/553). Every gap below the prior floors is authored known-failing skips with zero step failures; the workflow had been red on main and the mirrored local pre-push gate blocked all compliance-source pushes.
