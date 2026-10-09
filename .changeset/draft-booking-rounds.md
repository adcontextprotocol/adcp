---
"adcontextprotocol": minor
---

Add experimental optional `Product.booking_rounds[]` (`core/booking-round.json`, `enums/late-request-handling.json`) describing a seller's published booking calendar: airing window (`covers`), `opens_at`, `request_deadline`, `booking_deadline`, `expected_confirmation_at`, and `late_request_handling` with an optional `late_request_pricing_option_id` (#8010). Experimental under feature id `media_buy.booking_rounds`; the shape may change inside 3.x with the usual notice.
