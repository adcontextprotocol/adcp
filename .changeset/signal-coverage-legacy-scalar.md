---
"adcontextprotocol": minor
---

spec(signals): make deprecated `coverage_percentage` optional on signal responses.

`get_signals.signals[]` and wholesale feed signal payloads now keep `coverage_percentage` as an optional deprecated legacy scalar instead of a required deprecated field. `coverage_forecast` is the source of truth for detailed signal coverage planning; the scalar remains a backward-compatible fallback for clients that still consume it.

Adds validation coverage for `coverage_rate.low` and `coverage_rate.high` upper bounds, and pins the intended valid signal forecast shape where `presence: "present"` omits `signal_value`.

Closes #5089.
