---
---

Stage 0 of the domain-column rationalization (#4159 / specs/domain-column-rationalization.md): a script that resolves the ~10 `www.foo.com` canonicalization cases and the 6 hand-tuned divergence cases (DanAds, iPROM, Transfon, Mission Media, Triton Digital, Mangrove Digital) so the fleet is in a coherent state before Stage 1's resolver lands. Dry-run default; per-case fixes guard on expected before-state.
