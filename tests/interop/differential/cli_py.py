"""Coverage CLI for the Python SDK: owed_subscription_periods from
adcp.reporting.subscriptions over scenarios in the canonical vector input shape
(static/compliance/source/test-vectors/reporting-subscriptions/case.schema.json).

  stdin:  one input, one case ({"input": ...}), or a JSON array of either
          (with --lines: one such JSON document per line, answered line by line)
  stdout: one result, or an array of results in the same order:
          {"ok": true, "rows": [...], "obligations": [...]}
          | {"ok": false, "error": {"kind", "code", "detail", "message"}}

The input mapping is the SDK's own parity adapter
(adcp-client-python tests/test_reporting_subscription_parity.py). Zones resolve
from the tzdata wheel only (2026.6 is IANA 2026f), never the host's zoneinfo.
"""

from __future__ import annotations

import json
import os
import sys
import zoneinfo
from datetime import datetime, timezone
from importlib.metadata import version
from typing import Any

WANT_TZDATA = {"2026f": "2026.6"}.get(os.environ.get("ADCP_INTEROP_TZDATA", "2026f"))
if version("tzdata") != WANT_TZDATA and os.environ.get("ADCP_INTEROP_ALLOW_TZDATA_MISMATCH") != "1":
    raise SystemExit(f"tzdata {version('tzdata')} installed, need {WANT_TZDATA}")
zoneinfo.reset_tzpath(to=[])
zoneinfo.ZoneInfo.clear_cache()

from adcp.reporting.subscriptions import (  # noqa: E402
    CoverageInputError,
    SubscriptionAuthorization,
    SubscriptionBuy,
    SubscriptionDestination,
    SubscriptionOffering,
    SubscriptionVersionWindow,
    owed_subscription_periods,
)


def at(value: str | None) -> datetime | None:
    if value is None:
        return None
    text = value.replace("z", "Z").replace("t", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def z(value: Any) -> str:
    instant = value if isinstance(value, datetime) else at(value)
    instant = instant.astimezone(timezone.utc)
    millis = instant.microsecond // 1000
    base = instant.strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{millis:03d}Z" if millis else f"{base}Z"


def windows(versions: list[dict[str, Any]], readback_intervals=()) -> list[SubscriptionVersionWindow]:
    shared = [(at(item["deactivated_at"]), at(item.get("reactivated_at"))) for item in readback_intervals]
    result = []
    for index, record in enumerate(versions):
        following = versions[index + 1] if index + 1 < len(versions) else None
        ends_at = at(record.get("superseded_at")) or (at(following["accepted_at"]) if following else None)
        inactive = list(shared)
        if "deactivated_at" in record:
            inactive.append((at(record["deactivated_at"]), None))
        method = record.get("destination_method")
        result.append(
            SubscriptionVersionWindow(
                subscription_version=record["subscription_version"],
                accepted_at=at(record["accepted_at"]),
                ends_at=ends_at,
                configuration=record["configuration"],
                inactive_intervals=tuple(inactive),
                destination=None if method is None else SubscriptionDestination(method["pattern"], method.get("transport")),
            )
        )
    return result


def offerings(input_: dict[str, Any]) -> list[SubscriptionOffering]:
    source_timezone = input_["account"].get("source_timezone")
    result = []
    for wire in input_["offerings"]:
        schedule = wire["schedule"]
        resolved = (
            source_timezone
            if schedule.get("alignment") == "source_timezone" and schedule.get("period_timezone_policy") != "fixed"
            else None
        )
        result.append(SubscriptionOffering.from_offering(wire, period_timezone=resolved))
    return result


def buys(input_: dict[str, Any]) -> list[SubscriptionBuy]:
    result = []
    for buy in input_["buys"]:
        media_buy = {k: v for k, v in buy.items() if k not in {"canceled_at", "cancellation_effective_at"}}
        if "canceled_at" in buy:
            media_buy["cancellation"] = {"canceled_at": buy["canceled_at"]}
        if "cancellation_effective_at" in buy:
            media_buy["cancellation_effective_at"] = buy["cancellation_effective_at"]
        result.append(SubscriptionBuy.from_media_buy(media_buy))
    return result


def periods(input_: dict[str, Any]):
    account = input_["account"]
    return owed_subscription_periods(
        subscription=windows(input_["versions"], input_.get("inactive_intervals", [])),
        account_id=account["account_id"],
        buys=buys(input_),
        offerings=offerings(input_),
        account_timezone=account.get("timezone"),
        account_operator=account.get("operator"),
        now=at(input_["now"]),
        authorizations=[
            SubscriptionAuthorization(at(grant["authorized_at"]), at(grant.get("unauthorized_at")))
            for grant in account.get("grants", ())
        ],
        coverage=input_.get("coverage"),
        backfill_on_regrant=bool(input_.get("backfill_on_regrant", False)),
        status_retention_days=input_.get("status_retention_days"),
    )


def run(item: Any) -> dict[str, Any]:
    input_ = item["input"] if isinstance(item, dict) and "input" in item else item
    try:
        owed = periods(input_)
    except CoverageInputError as error:
        kind = "budget" if error.code == "COVERAGE_BUDGET_EXCEEDED" else "coverage_input"
        return {"ok": False, "error": {"kind": kind, "code": error.code, "detail": getattr(error, "detail", None), "message": str(error)}}
    except Exception as error:  # noqa: BLE001 - every other failure is a crash to report
        return {"ok": False, "error": {"kind": "crash", "code": getattr(error, "code", None), "detail": type(error).__name__, "message": str(error)}}
    obligations = []
    rows = []
    for period in owed:
        stub = {"stub": True} if period.stub else {}
        start, end = z(period.period_start), z(period.period_end)
        obligations.append(
            {
                "subscription_version": period.delivery_config_version,
                "offering_id": period.offering_id,
                "period_start": start,
                "period_end": end,
                **stub,
                "media_buy_ids": list(period.media_buy_ids),
            }
        )
        for media_buy_id in period.media_buy_ids:
            rows.append(
                {
                    "subscription_version": period.delivery_config_version,
                    "media_buy_id": media_buy_id,
                    "offering_id": period.offering_id,
                    "period_start": start,
                    "period_end": end,
                    **stub,
                }
            )
    return {"ok": True, "rows": rows, "obligations": obligations}


def answer(payload: Any) -> Any:
    return [run(item) for item in payload] if isinstance(payload, list) else run(payload)


def main() -> None:
    if "--lines" in sys.argv:
        for line in sys.stdin:
            if line.strip():
                sys.stdout.write(json.dumps(answer(json.loads(line))) + "\n")
                sys.stdout.flush()
        return
    sys.stdout.write(json.dumps(answer(json.load(sys.stdin))) + "\n")


if __name__ == "__main__":
    main()
