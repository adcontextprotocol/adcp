"""Python buyer CLI for the interop matrix (tests/interop/matrix/CONTRACT.txt).

  python -I buyer.py <command>   < {"url": ..., "token": ..., ...args}

Uses only the published ``adcp`` client: ``client.reporting`` for subscription
writes, the typed task methods for wire reads, ``owed_subscription_periods``
for coverage, and ``client.accounts`` for account requests. The coverage input
is built from wire responses only (case.schema.json says where each field comes
from); the few wire observations a buyer must remember between calls (the last
authorized_at it saw, unauthorized_at values, the account registry) are kept in
a JSON file under $ADCP_INTEROP_STATE_DIR.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import zoneinfo
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

zoneinfo.reset_tzpath(to=[])
zoneinfo.ZoneInfo.clear_cache()

from adcp import ADCPClient  # noqa: E402
from adcp.account_outcomes import next_step  # noqa: E402
from adcp.accounts import AccountRecord, InMemoryAccountStorage  # noqa: E402
from adcp.reporting.subscriptions import (  # noqa: E402
    CoverageInputError,
    SubscriptionAuthorization,
    SubscriptionBuy,
    SubscriptionOffering,
    SubscriptionVersionWindow,
    owed_subscription_periods,
)
from adcp.types.core import AgentConfig  # noqa: E402


def log(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


def at(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def z(value: Any) -> str:
    instant = value if isinstance(value, datetime) else at(str(value))
    instant = instant.astimezone(timezone.utc)
    millis = instant.microsecond // 1000
    base = instant.strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{millis:03d}Z" if millis else f"{base}Z"


def dump(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True, by_alias=True)
    if isinstance(value, dict):
        return {k: dump(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [dump(v) for v in value]
    return value


def sort_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda r: (at(r["period_start"]), r["subscription_version"], r["offering_id"].encode(), r["media_buy_id"].encode()))


# -- persisted buyer state ---------------------------------------------------------------


class State:
    def __init__(self, url: str, token: str) -> None:
        directory = Path(os.environ.get("ADCP_INTEROP_STATE_DIR", "/tmp/adcp-interop-state"))
        directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(f"py|{token}|{url}".encode()).hexdigest()[:16]
        self.path = directory / f"py-buyer-{digest}.json"
        self.data: dict[str, Any] = json.loads(self.path.read_text()) if self.path.exists() else {}

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=1, sort_keys=True))


class FileAccountStorage(InMemoryAccountStorage):
    """The SDK's account registry, persisted in the state file between CLI calls."""

    def __init__(self, state: State) -> None:
        super().__init__()
        self._state = state
        for seller, entries in state.data.get("accounts", {}).items():
            for key, record in entries.items():
                self._records[(seller, key)] = AccountRecord(**record) if isinstance(record, dict) else record

    async def save(self, seller: str, key: str, record: AccountRecord) -> None:
        await super().save(seller, key, record)
        self._state.data.setdefault("accounts", {}).setdefault(seller, {})[key] = dump(record) if hasattr(record, "model_dump") else record.__dict__
        self._state.save()

    async def delete(self, seller: str, key: str) -> None:
        await super().delete(seller, key)
        self._state.data.get("accounts", {}).get(seller, {}).pop(key, None)
        self._state.save()


def client_for(args: dict[str, Any], state: State) -> ADCPClient:
    config = AgentConfig(
        id="interop-seller",
        agent_uri=args["url"],
        protocol="mcp",
        auth_token=args["token"],
        auth_header="Authorization",
        auth_type="bearer",
        timeout=60.0,
    )
    return ADCPClient(config, account_storage=FileAccountStorage(state))


def data_of(result: Any, task: str) -> dict[str, Any]:
    if not getattr(result, "success", False) or result.data is None:
        raise RuntimeError(f"{task} failed: {getattr(result, 'error', None)} {getattr(result, 'adcp_error', None)}")
    return dump(result.data)


# -- commands ----------------------------------------------------------------------------


async def subscribe(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    result = await client.reporting.subscribe(args["subscription"])
    return {"ok": True, "action": result.action, "subscription_version": result.subscription_version}


async def unsubscribe(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    result = await client.reporting.unsubscribe(args["subscription_id"])
    return {"ok": True, "action": result.action}


async def owed(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    from adcp.types import GetAdcpCapabilitiesRequest, GetMediaBuysRequest, GetPrincipalRequest, GetReportingStatusRequest, ListAccountsRequest

    subscription_id, account_id = args["subscription_id"], args["account_id"]
    capabilities = data_of(await client.get_adcp_capabilities(GetAdcpCapabilitiesRequest()), "get_adcp_capabilities")
    delivery = capabilities.get("media_buy", {}).get("reporting_delivery", {})
    principal = data_of(await client.get_principal(GetPrincipalRequest()), "get_principal")
    subscriptions = find_subscriptions(principal)
    sub_state = next((s for s in subscriptions if s.get("subscription_id") == subscription_id), None)
    if sub_state is None:
        raise RuntimeError(f"get_principal has no reporting subscription {subscription_id!r}")
    accounts = data_of(await client.list_accounts(ListAccountsRequest()), "list_accounts").get("accounts", [])
    account = next((a for a in accounts if a.get("account_id") == account_id), None)
    status = data_of(
        await client.get_reporting_status(GetReportingStatusRequest(account={"account_id": account_id}, view="periods")),
        "get_reporting_status",
    )
    buys = data_of(await client.get_media_buys(GetMediaBuysRequest(account={"account_id": account_id})), "get_media_buys").get("media_buys", []) if account else []

    # Remembered wire observations.
    memory = state.data.setdefault("grants", {}).setdefault(account_id, {})
    for entry in sub_state.get("accounts_unauthorized", []) or []:
        if entry.get("account_id") == account_id:
            memory["unauthorized_at"] = entry["unauthorized_at"]
    if account is not None:
        auth = (account.get("authorization") or {}).get("authorized_at")
        if auth is not None and memory.get("authorized_at") not in (None, auth):
            memory.setdefault("previous_authorized_at", memory["authorized_at"])
        if auth is not None:
            memory["authorized_at"] = auth
        memory["timezone"] = account.get("timezone")
        memory["operator"] = account.get("operator")
    state.save()

    grants = build_grants(account, memory)
    coverage_entry = next((c for c in status.get("subscription_coverage", []) or [] if c.get("subscription_id") == subscription_id), None)
    coverage = None if coverage_entry is None else {k: coverage_entry[k] for k in ("excluded", "gaps", "timezone_cutovers") if k in coverage_entry}
    input_ = {
        "subscription_id": subscription_id,
        "versions": version_records(sub_state),
        "account": {
            "account_id": account_id,
            **({"timezone": memory["timezone"]} if memory.get("timezone") else {}),
            **({"operator": memory["operator"]} if memory.get("operator") else {}),
            "grants": grants,
        },
        "buys": [buy_record(b) for b in buys],
        "offerings": delivery.get("offerings", []),
        "now": args["now"],
    }
    if sub_state.get("inactive_intervals"):
        input_["inactive_intervals"] = sub_state["inactive_intervals"]
    if coverage:
        input_["coverage"] = coverage
    if "status_retention_days" in delivery:
        input_["status_retention_days"] = delivery["status_retention_days"]
    if (delivery.get("subscriptions") or {}).get("backfill_on_regrant"):
        input_["backfill_on_regrant"] = True

    rows = compute(input_) if grants else []
    wire = []
    for period in status.get("periods", []) or []:
        if period.get("delivery_config_id") != subscription_id:
            continue
        for media_buy_id in period.get("media_buy_ids", []):
            row = {
                "subscription_version": period["delivery_config_version"],
                "media_buy_id": media_buy_id,
                "offering_id": period.get("offering_id"),
                "period_start": z(period["period"]["start"]),
                "period_end": z(period["period"]["end"]),
            }
            if period.get("stub"):
                row["stub"] = True
            wire.append(row)
    return {"ok": True, "rows": rows, "wire_obligations": sort_rows(wire), "input": input_}


def find_subscriptions(principal: dict[str, Any]) -> list[dict[str, Any]]:
    """get_principal result: principal-state reporting_subscriptions[] (wherever the result nests it)."""
    stack = [principal]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            value = node.get("reporting_subscriptions")
            if isinstance(value, list) and all(isinstance(v, dict) and "accepted_at" in v for v in value):
                return value
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return []


def version_records(sub_state: dict[str, Any]) -> list[dict[str, Any]]:
    records = []
    for prior in reversed(sub_state.get("prior_versions", []) or []):
        record = {"subscription_version": prior["subscription_version"], "accepted_at": prior["accepted_at"], "configuration": prior["configuration"]}
        if prior.get("superseded_at"):
            record["superseded_at"] = prior["superseded_at"]
        records.append(record)
    current = {
        "subscription_version": sub_state["subscription_version"],
        "accepted_at": sub_state["accepted_at"],
        "configuration": sub_state["configuration"],
    }
    if sub_state.get("state") == "inactive" and sub_state.get("deactivated_at"):
        current["deactivated_at"] = sub_state["deactivated_at"]
    records.append(current)
    return records


def build_grants(account: dict[str, Any] | None, memory: dict[str, Any]) -> list[dict[str, Any]]:
    revoked = memory.get("unauthorized_at")
    if account is not None:
        authorization = account.get("authorization") or {}
        auth = authorization.get("authorized_at")
        if auth is None:
            return []
        if revoked and at(revoked) > at(auth):
            # An interruption inside this chain: authorized_at did not move.
            return [{"authorized_at": auth, "unauthorized_at": revoked}, {"authorized_at": authorization.get("regranted_at") or auth}]
        previous = memory.get("previous_authorized_at")
        if revoked and previous and at(auth) > at(revoked):
            # A new chain after the old one lapsed.
            return [{"authorized_at": previous, "unauthorized_at": revoked}, {"authorized_at": auth}]
        return [{"authorized_at": auth}]
    if revoked and memory.get("authorized_at"):
        return [{"authorized_at": memory["authorized_at"], "unauthorized_at": revoked}]
    return []


def buy_record(buy: dict[str, Any]) -> dict[str, Any]:
    record = {
        "media_buy_id": buy["media_buy_id"],
        "confirmed_at": buy.get("confirmed_at"),
        "start_time": buy["start_time"],
        "end_time": buy["end_time"],
        "packages": [
            {"package_id": p["package_id"], "reporting_delivery_offering_ids": list(p.get("reporting_delivery_offering_ids", []))}
            for p in buy.get("packages", [])
        ],
    }
    if (buy.get("cancellation") or {}).get("canceled_at"):
        record["canceled_at"] = buy["cancellation"]["canceled_at"]
    for key in ("cancellation_effective_at", "completed_at", "flight_history"):
        if buy.get(key):
            record[key] = buy[key]
    return record


def compute(input_: dict[str, Any]) -> list[dict[str, Any]]:
    """owed_subscription_periods over the coverage input (the SDK's parity mapping, as in differential/cli_py.py)."""
    versions = input_["versions"]
    shared = [(at(i["deactivated_at"]), at(i.get("reactivated_at"))) for i in input_.get("inactive_intervals", [])]
    windows = []
    for index, record in enumerate(versions):
        following = versions[index + 1] if index + 1 < len(versions) else None
        inactive = list(shared)
        if "deactivated_at" in record:
            inactive.append((at(record["deactivated_at"]), None))
        windows.append(
            SubscriptionVersionWindow(
                subscription_version=record["subscription_version"],
                accepted_at=at(record["accepted_at"]),
                ends_at=at(record.get("superseded_at")) or (at(following["accepted_at"]) if following else None),
                configuration=record["configuration"],
                inactive_intervals=tuple(inactive),
            )
        )
    buys = []
    for buy in input_["buys"]:
        media_buy = {k: v for k, v in buy.items() if k not in {"canceled_at"}}
        if "canceled_at" in buy:
            media_buy["cancellation"] = {"canceled_at": buy["canceled_at"]}
        buys.append(SubscriptionBuy.from_media_buy(media_buy))
    owed = owed_subscription_periods(
        subscription=windows,
        account_id=input_["account"]["account_id"],
        buys=buys,
        offerings=[SubscriptionOffering.from_offering(o) for o in input_["offerings"]],
        account_timezone=input_["account"].get("timezone"),
        account_operator=input_["account"].get("operator"),
        now=at(input_["now"]),
        authorizations=[SubscriptionAuthorization(at(g["authorized_at"]), at(g.get("unauthorized_at"))) for g in input_["account"]["grants"]],
        coverage=input_.get("coverage"),
        backfill_on_regrant=bool(input_.get("backfill_on_regrant", False)),
        status_retention_days=input_.get("status_retention_days"),
    )
    rows = []
    for period in owed:
        for media_buy_id in period.media_buy_ids:
            row = {
                "subscription_version": period.delivery_config_version,
                "media_buy_id": media_buy_id,
                "offering_id": period.offering_id,
                "period_start": z(period.period_start),
                "period_end": z(period.period_end),
            }
            if period.stub:
                row["stub"] = True
            rows.append(row)
    return sort_rows(rows)


def outcome_json(outcome: Any) -> dict[str, Any]:
    kind = type(outcome).__name__.removeprefix("Account").lower()
    out: dict[str, Any] = {"ok": True, "kind": kind, "next_step": next_step(outcome)}
    for name in ("account_id", "request_id"):
        value = getattr(outcome, name, None)
        if value is not None:
            out[name] = value
    account = getattr(outcome, "account", None)
    if out.get("account_id") is None and account is not None:
        out["account_id"] = dump(account).get("account_id")
    action = getattr(outcome, "action", None)
    if action is not None:
        out["action"] = dump(action) if hasattr(action, "model_dump") else {k: v for k, v in vars(action).items() if not k.startswith("_")}
    candidates = getattr(outcome, "candidates", None)
    if candidates:
        out["candidates"] = [dump(c) if not isinstance(c, dict) else c for c in candidates]
    errors = getattr(outcome, "errors", None)
    if errors:
        out["errors"] = [dict(e) for e in errors]
    return out


async def account_open(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    key = {"brand": args["brand"], "operator": args["operator"]}
    options = {k: args[k] for k in ("billing", "payment_terms") if k in args}
    outcome = await client.accounts.ensure(key, **options)
    return outcome_json(outcome)


async def account_refresh(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    moved = await client.accounts.refresh()
    return {"ok": True, "moved": [outcome_json(m) for m in moved]}


async def account_change(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    from adcp.types import RequestAccountRequest

    key = state.data.setdefault("idempotency", 0) + 1
    state.data["idempotency"] = key
    state.save()
    body = {"account_id": args["account_id"], **args["changes"], "idempotency_key": f"interop-py-change-{key:08d}-{os.getpid()}"}
    if "revision" in args:
        body["revision"] = args["revision"]
    result = await client.request_account(RequestAccountRequest(**body))
    data = data_of(result, "request_account")
    record = data.get("request", {})
    out = {"ok": True, "state": record.get("state")}
    for name in ("resolution", "account_id", "request_id", "pending_action", "not_carried_over", "effective_at", "errors"):
        if name in record:
            out[name] = record[name]
    return out


async def account_requests(client: ADCPClient, args: dict[str, Any], state: State) -> dict[str, Any]:
    from adcp.types import ListAccountsRequest

    data = data_of(await client.list_accounts(ListAccountsRequest(request_ids=args["request_ids"])), "list_accounts")
    return {"ok": True, "requests": data.get("account_requests", [])}


COMMANDS = {
    "subscribe": subscribe,
    "unsubscribe": unsubscribe,
    "owed": owed,
    "account_open": account_open,
    "account_refresh": account_refresh,
    "account_change": account_change,
    "account_requests": account_requests,
}


async def main() -> None:
    command = sys.argv[1]
    args = json.load(sys.stdin)
    state = State(args["url"], args["token"])
    client = client_for(args, state)
    try:
        result = await COMMANDS[command](client, args, state)
    except CoverageInputError as error:
        result = {"ok": False, "error": f"{error.code}/{getattr(error, 'detail', None)}: {error}"}
    except Exception as error:  # noqa: BLE001 - every failure goes back to the harness
        log(f"{command} failed:", repr(error))
        result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    finally:
        await client.close()
    print(json.dumps(result, default=str), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
