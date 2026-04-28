---
---

Brand viewer (`/brand/view/<domain>`): show explicit "Agents this brand operates" and "Agents authorized to sell this brand's inventory" sections with empty states. Both sections always render, sourcing from `/api/registry/operator` and `/api/registry/publisher`. When empty, hint text explains what's missing (no member claim, no `adagents.json`, etc.) so a viewer can distinguish "nothing set up" from "registry isn't surfacing it."
