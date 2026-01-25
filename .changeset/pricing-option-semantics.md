---
"adcontextprotocol": major
---

Clarify pricing option field semantics with better separation of hard constraints vs soft hints

**Breaking Changes:**
- Rename `fixed_rate` → `fixed_price` in all pricing option schemas
- Move `price_guidance.floor` → top-level `floor_price` field
- Remove `is_fixed` discriminator (presence of `fixed_price` indicates fixed pricing)

**Schema Consolidation:**
- Consolidate 9 pricing schemas into 7 (one per pricing model)
- All models now support both fixed and auction pricing modes

**Semantic Distinction:**
- Hard constraints (`fixed_price`, `floor_price`) - Publisher-enforced prices that cause bid rejection
- Soft hints (`price_guidance.p25`, `.p50`, `.p75`, `.p90`) - Historical percentiles for bid calibration
