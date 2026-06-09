---
"adcontextprotocol": patch
---

fix(aao): follow ads.txt redirect chains for managerdomain fallback (#5440)

Publisher domains whose `/.well-known/adagents.json` is missing can still be
authorized through the legacy ads.txt `MANAGERDOMAIN` fallback when the manager
manifest explicitly scopes the publisher. The fallback now follows normal
ads.txt redirect chains before parsing `MANAGERDOMAIN`, fixing managed-network
setups where the publisher's `/ads.txt` redirects through a canonical hostname
and then to a hosted ads.txt file. The adagents docs also clarify that hostname
redirect chains must end at a `200` JSON file when relying on direct
well-known deployment.
