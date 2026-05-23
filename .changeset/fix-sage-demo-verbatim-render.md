---
---

fix(addie): require verbatim tool-result rendering in Sage sandbox demos

Adds an explicit render-verbatim instruction to Sage's demo-scenario prompt in
certification modules. Without it Claude could satisfy "run a demo" by writing
explanatory prose rather than displaying the actual tool response, causing the
learner to see no catalog data on the first get_products call in B1. Closes #4961.
