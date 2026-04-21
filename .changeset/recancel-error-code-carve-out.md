---
"adcontextprotocol": patch
---

spec(media-buy): re-cancel error code — carve `NOT_CANCELLABLE` out of the `INVALID_STATE` terminal-state rule (#2617)

Before this change, §128 allowed `NOT_CANCELLABLE` as a MAY for cancellation refusals, while §129 required `INVALID_STATE` as a MUST for any update to a terminal-state buy. Re-cancel — a `canceled: true` update against a buy already in `canceled` — fell under both rules at once, leaving the canonical error code ambiguous. The storyboard vector (`media_buy_seller/invalid_transitions > second_cancel`) pinned `NOT_CANCELLABLE`, so state-machine-first implementations returning `INVALID_STATE` were strictly spec-conformant against §129 but failed the vector.

This clarification carves the cancellation case out of §129 and pins `NOT_CANCELLABLE` as the required code for re-cancel. The cancellation-specific error wins over the generic terminal-state error. No vector change — the storyboard is now aligned with the spec. Agents currently returning `NOT_CANCELLABLE` stay conformant; agents returning `INVALID_STATE` on re-cancel need to switch before 3.0 GA.
