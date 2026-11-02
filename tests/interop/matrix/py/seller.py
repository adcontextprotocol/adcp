"""Python reference seller for the interop matrix (tests/interop/matrix/CONTRACT.txt).

Principal-level reporting subscriptions on the Python SDK's managed path:
``ReliableReportingService(subscriptions=SubscriptionOptions(...))`` installed
on an ``ADCPHandler`` that already serves ``list_accounts`` and
``get_media_buys``, served over MCP with ``adcp.server.serve``. The world is
in memory and driven by the harness through the control route: a virtual
clock, grants pushed into the SDK's grant journal, and buys.

Until adcontextprotocol/adcp-client-python ships its own reporting-subscriptions
reference seller, this one stands in for it; it uses only the published
package's public surface, except ``service._managed.engine.owed_periods`` for
the seller's own owed set (the docs name ``engine.owed_periods`` as the way to
list it, and the managed service does not expose the engine publicly yet).
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
import uuid
import zoneinfo
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from typing import Any

zoneinfo.reset_tzpath(to=[])
zoneinfo.ZoneInfo.clear_cache()

from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.routing import Route  # noqa: E402

from adcp.reporting import PrincipalRef, SubscriptionOptions  # noqa: E402
from adcp.reporting.fixtures import OFFICIAL_OFFERING_ID, redacted_capabilities  # noqa: E402
from adcp.reporting.ledger import ReportingDefinitionBinding  # noqa: E402
from adcp.reporting.service import ReliableReportingService, ReportingAccountContext  # noqa: E402
from adcp.reporting.testing import DeterministicReportingClock  # noqa: E402
from adcp.server import ADCPHandler, serve  # noqa: E402
from adcp.server.auth import BearerTokenAuth, Principal, auth_context_factory  # noqa: E402

ACCOUNT_ID = "acct_1"
ACCOUNT_TIMEZONE = "America/Santiago"
OPERATOR = "agency.example"
ALLOWED_TASKS = ["get_reporting_status", "get_media_buys", "sync_reporting_status", "sync_reporting_receipts"]
# The fixture source contract (adcp.reporting.fixtures): every offering must match one.
_CONTRACT = next(o for o in redacted_capabilities().offerings if o.offering_id == OFFICIAL_OFFERING_ID).contract
DEFINITION = ReportingDefinitionBinding(
    report_definition_uri=_CONTRACT.report_definition_uri,
    report_definition_sha256=_CONTRACT.report_definition_sha256,
    schema_version=_CONTRACT.schema_version,
    schema_uri=_CONTRACT.schema_uri,
    schema_sha256=_CONTRACT.schema_sha256,
)


def log(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


def at(text: str) -> datetime:
    value = text.replace("Z", "+00:00")
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def z(value: Any) -> str:
    instant = value if isinstance(value, datetime) else at(str(value))
    instant = instant.astimezone(timezone.utc)
    millis = instant.microsecond // 1000
    base = instant.strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{millis:03d}Z" if millis else f"{base}Z"


def offering(offering_id: str, alignment: str) -> dict[str, Any]:
    return {
        "offering_id": offering_id,
        "feed_purpose": "analytics",
        "report_definition_id": _CONTRACT.report_definition_id,
        "report_definition_uri": _CONTRACT.report_definition_uri,
        "report_definition_sha256": _CONTRACT.report_definition_sha256,
        "reporting_profile": {
            "id": _CONTRACT.reporting_profile,
            "version": _CONTRACT.schema_version,
            "schema_uri": _CONTRACT.schema_uri,
            "schema_sha256": _CONTRACT.schema_sha256,
            "schema_dialect": _CONTRACT.schema_dialect,
            "schema_ref_policy": _CONTRACT.schema_ref_policy,
            "grain": "one row per package per period",
            "primary_keys": ["account_id", "package_id"],
        },
        "schedule": {"period_duration": "P1D", "alignment": alignment, "delivery_sla": "PT6H"},
        "supported_finality": ["official"],
        "reconciliation_mode": "delivery_only",
        "standard_dimensions": ["package"],
    }


OFFERINGS = [offering("off_daily_local", "account_timezone"), offering("off_daily_utc", "utc")]


class Source:
    """No upstream: every slice is observed with one zero row per requested buy."""

    @property
    def capabilities(self) -> Any:
        return redacted_capabilities()

    def fetch_slice(self, request: Any) -> list[dict[str, Any]]:
        return [
            {"media_buy_id": item.media_buy_id, "campaign_id": "campaign-1", "impressions": 0, "spend": "0"}
            for item in request.coverage.constituents
        ]


class World:
    def __init__(self, start: datetime) -> None:
        self.clock = DeterministicReportingClock(start)
        self.grants: dict[str, dict[str, Any]] = {}  # principal -> {"authorized": bool, "since": datetime}
        self.buys: dict[str, dict[str, Any]] = {}
        self.accounts: dict[str, dict[str, Any]] = {
            ACCOUNT_ID: {
                "account_id": ACCOUNT_ID,
                "name": "Acme",
                "brand": {"domain": "acme.example"},
                "operator": OPERATOR,
                "status": "active",
                "timezone": ACCOUNT_TIMEZONE,
                "currency": "USD",
                "billing": "operator",
            }
        }
        self.revisions: dict[str, int] = {ACCOUNT_ID: 1}
        self.requests: dict[str, dict[str, Any]] = {}  # request_id -> record (with "_owner", "_key")
        self.errors: list[str] = []

    def now_text(self) -> str:
        return z(self.clock())


def principal_of(context: Any) -> str:
    identity = getattr(context, "caller_identity", None)
    if not identity:
        raise PermissionError("authenticated caller required")
    return identity


class Seller(ADCPHandler):
    """The platform the reporting service is installed on."""

    def __init__(self, world: World) -> None:
        self.world = world

    async def get_adcp_capabilities(self, params: Any, context: Any = None) -> Any:
        # The managed path merges its principal block into this one but leaves the fields 3.3.0-beta.3
        # requires of it (optimistic_concurrency, and the destination fields its reporting_destinations
        # section implies) to the host; without them its own client refuses the capabilities.
        return {
            "adcp": {
                "major_versions": [3],
                "idempotency": {"supported": True, "replay_ttl_seconds": 86400},
                "principal": {
                    "optimistic_concurrency": False,
                    "max_reporting_destinations": 4,
                    "reporting_destination_offerings": [
                        {"pattern": "file_transfer", "transports": ["s3"], "formats": ["jsonl"], "verification_profiles": ["manifest_checksums"]}
                    ],
                    "suspension_interval_seconds": 3600,
                },
            },
            "experimental_features": ["account.requests"],
            "supported_protocols": ["media_buy"],
            "account": {
                "supported_billing": ["operator", "agent"],
                "requests": {
                    "supported": True,
                    "request_task": "request_account",
                    "read_task": "list_accounts",
                    "changeable_attributes": ["billing", "currency", "timezone"],
                    "pending_action_kinds": ["review", "sign_up"],
                },
            },
        }

    def _visible_account(self, principal: str, account_id: str) -> dict[str, Any] | None:
        account = self.world.accounts.get(account_id)
        if account is None:
            return None
        if account_id == ACCOUNT_ID:
            grant = self.world.grants.get(principal)
            if not grant or not grant["authorized"]:
                return None
            return {
                **account,
                "revision": self.world.revisions[account_id],
                "authorization": {"allowed_tasks": list(ALLOWED_TASKS), "authorized_at": z(grant["chain_start"])},
            }
        owner = account.get("_owner")
        if owner != principal:
            return None
        clean = {k: v for k, v in account.items() if not k.startswith("_")}
        return {**clean, "revision": self.world.revisions[account_id]}

    async def list_accounts(self, params: Any, context: Any = None) -> Any:
        principal = principal_of(context)
        params = params if isinstance(params, dict) else params.model_dump(mode="json", exclude_none=True)
        accounts = [a for a in (self._visible_account(principal, i) for i in self.world.accounts) if a is not None]
        response: dict[str, Any] = {"accounts": accounts}
        if params.get("include_requests") or params.get("request_ids"):
            wanted = set(params.get("request_ids") or [])
            records = [
                self._record(r)
                for r in self.world.requests.values()
                if r["_owner"] == principal and (not wanted or r["request_id"] in wanted)
            ]
            records.sort(key=lambda r: r["updated_at"], reverse=True)
            response["account_requests"] = records
            response["account_requests_pagination"] = {"has_more": False}
        return response

    async def get_media_buys(self, params: Any, context: Any = None) -> Any:
        principal = principal_of(context)
        grant = self.world.grants.get(principal)
        if not grant or not grant["authorized"]:
            return {"media_buys": []}
        return {"media_buys": [dict(buy) for buy in self.world.buys.values()]}

    # -- account requests ------------------------------------------------------------------

    @staticmethod
    def _record(raw: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in raw.items() if not k.startswith("_")}

    def _new_account(self, owner: str, requested: dict[str, Any], **overrides: Any) -> dict[str, Any]:
        account_id = f"acct_{uuid.uuid4().hex[:10]}"
        account = {
            "account_id": account_id,
            "name": requested.get("brand", {}).get("domain", "account"),
            "brand": requested.get("brand", {"domain": "unknown.example"}),
            "operator": requested.get("operator", OPERATOR),
            "status": "active",
            "timezone": ACCOUNT_TIMEZONE,
            "currency": "USD",
            "billing": requested.get("billing", "operator"),
            "_owner": owner,
            **overrides,
        }
        self.world.accounts[account_id] = account
        self.world.revisions[account_id] = 1
        return account

    def _resolve(self, raw: dict[str, Any], resolution: str, account: dict[str, Any], **extra: Any) -> None:
        raw.pop("pending_action", None)
        raw.pop("candidates", None)
        raw["state"] = "resolved"
        raw["resolution"] = resolution
        raw["account_id"] = account["account_id"]
        raw["account"] = {k: v for k, v in account.items() if not k.startswith("_")} | {
            "revision": self.world.revisions[account["account_id"]]
        }
        raw.update(extra)
        raw["updated_at"] = self.world.now_text()

    async def request_account(self, params: Any, context: Any = None) -> Any:
        principal = principal_of(context)
        params = params if isinstance(params, dict) else params.model_dump(mode="json", exclude_none=True)
        changes = {k: params[k] for k in ("billing", "currency", "timezone", "sandbox", "payment_terms") if k in params}
        if params.get("account_id") and not changes:
            # Continue a request: pick a candidate from an ambiguous one.
            raw = self.world.requests.get(params.get("request_id", ""))
            if raw is None or raw["_owner"] != principal:
                return {"status": "failed", "adcp_error": {"code": "REQUEST_NOT_FOUND"}, "errors": [{"code": "REQUEST_NOT_FOUND", "message": "unknown request"}]}
            account = self.world.accounts.get(params["account_id"])
            self._resolve(raw, "matched", {**account, "account_id": params["account_id"]})
            return {"status": "completed", "request": self._record(raw)}
        now = self.world.now_text()
        if params.get("account_id"):
            key = json.dumps(["change", params["account_id"], sorted(changes)])
            requested = {"account_id": params["account_id"], **changes}
        else:
            key = json.dumps(["open", params.get("brand", {}).get("domain"), params.get("operator")])
            requested = {k: params[k] for k in ("brand", "operator", "billing", "payment_terms") if k in params}
        for raw in self.world.requests.values():
            if raw["_owner"] == principal and raw["_key"] == key and raw["state"] in ("in_review", "ambiguous"):
                return {"status": "completed", "request": self._record(raw)}
        raw: dict[str, Any] = {
            "request_id": f"areq_{uuid.uuid4().hex[:12]}",
            "state": "in_review",
            "requested": requested,
            "created_at": now,
            "updated_at": now,
            "_owner": principal,
            "_key": key,
        }
        self.world.requests[raw["request_id"]] = raw
        if not params.get("account_id"):
            domain = requested.get("brand", {}).get("domain")
            if domain == "review.example":
                raw["pending_action"] = {
                    "waiting_on": "buyer",
                    "kind": "sign_up",
                    "url": f"https://seller.example/register?ref={raw['request_id']}",
                    "message": "Register the advertiser and accept the terms.",
                }
            elif domain == "ready.example":
                self._resolve(raw, "created", self._new_account(principal, requested))
            elif domain == "acme.example":
                self._resolve(raw, "matched", self.world.accounts[ACCOUNT_ID])
            elif domain == "ambiguous.example":
                # account-request-record.json: candidates has minItems 2, so a second caller-visible
                # account is listed (created for this caller on first use, as the TS seller does).
                second = next(
                    (a for a in self.world.accounts.values() if a.get("_owner") == principal and a.get("name") == "Acme Europe"),
                    None,
                ) or self._new_account(principal, {"brand": {"domain": "acme.example"}, "operator": OPERATOR}, name="Acme Europe")
                raw["state"] = "ambiguous"
                raw["candidates"] = [{"account_id": ACCOUNT_ID, "name": "Acme"}, {"account_id": second["account_id"], "name": "Acme Europe"}]
            elif domain == "reject.example":
                raw["state"] = "rejected"
                raw["errors"] = [{"code": "ACCOUNT_REQUEST_REJECTED", "message": "The seller declined this advertiser."}]
            else:
                raw["pending_action"] = {"waiting_on": "seller", "kind": "review", "message": "Reviewing the request."}
            return {"status": "completed", "request": self._record(raw)}
        target = self.world.accounts.get(params["account_id"])
        if target is None:
            raw["state"] = "rejected"
            raw["errors"] = [{"code": "ACCOUNT_NOT_FOUND", "message": "unknown account"}]
        elif "timezone" in changes:
            target["timezone"] = changes["timezone"]
            self.world.revisions[target["account_id"]] += 1
            self._resolve(raw, "updated", target)
        elif "currency" in changes:
            created = self._new_account(principal, {"brand": target["brand"], "operator": target["operator"]}, currency=changes["currency"])
            self._resolve(raw, "created", created, not_carried_over=["reporting_delivery_configs", "notification_configs"])
        elif "billing" in changes:
            raw["pending_action"] = {"waiting_on": "seller", "kind": "review", "message": "Billing changes are reviewed."}
        else:
            raw["state"] = "rejected"
            raw["errors"] = [{"code": "UNSUPPORTED_FEATURE", "message": "This change is not supported."}]
        return {"status": "completed", "request": self._record(raw)}

    def control_resolve_request(self, request_id: str, action: str) -> dict[str, Any]:
        raw = self.world.requests[request_id]
        if raw["state"] != "in_review":
            raise ValueError(f"request {request_id} is {raw['state']}, not in_review")
        if action == "reject":
            raw.pop("pending_action", None)
            raw["state"] = "rejected"
            raw["errors"] = [{"code": "ACCOUNT_REQUEST_REJECTED", "message": "Declined in review."}]
            raw["updated_at"] = self.world.now_text()
        elif "account_id" in raw["requested"]:
            target = self.world.accounts[raw["requested"]["account_id"]]
            for key in ("billing", "payment_terms"):
                if key in raw["requested"]:
                    target[key] = raw["requested"][key]
            self.world.revisions[target["account_id"]] += 1
            self._resolve(raw, "updated", target, effective_at=self.world.now_text())
        else:
            self._resolve(raw, "created", self._new_account(raw["_owner"], raw["requested"]))
        return self._record(raw)


def account_context(configuration: Any) -> ReportingAccountContext:
    subscription = getattr(configuration, "subscription", None)
    offering_id = getattr(subscription, "offering_id", None) or "off_daily_utc"
    chosen = next((o for o in OFFERINGS if o["offering_id"] == offering_id), OFFERINGS[1])
    return ReportingAccountContext(
        account_id=configuration.account_id,
        adapter="reference",
        currency="USD",
        account_timezone=ACCOUNT_TIMEZONE,
        source_scope=redacted_capabilities().source_scope,
        official_offering_id=OFFICIAL_OFFERING_ID,
        requested_dimensions=("campaign_id",),
        capability_offering=chosen,
        publication_namespace="reporting-source:interop",
    )


def caller_resolver(request: Any, context: Any | None) -> Any:
    """The reporting tasks' caller: the bearer principal, on the account the request names."""
    from adcp.reporting.ledger import ReportingStatusCaller

    raw = request if isinstance(request, dict) else request.model_dump(mode="json", exclude_none=True)
    account_id = (raw.get("account") or {}).get("account_id") or getattr(context, "account_id", None) or ACCOUNT_ID
    return ReportingStatusCaller(account_id=account_id, consumer_id=principal_of(context))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def build(start: datetime) -> tuple[World, ReliableReportingService, Seller, Any]:
    world = World(start)
    service = ReliableReportingService.memory(
        account_context=account_context,
        caller_resolver=caller_resolver,
        clock=world.clock,
        read_jitter_window=timedelta(0),
        status_retention_days=30,
        subscriptions=SubscriptionOptions(
            max_accounts=100,
            definitions={o["offering_id"]: DEFINITION for o in OFFERINGS},
            buy_offerings=lambda buy: {
                pkg["package_id"]: list(pkg.get("reporting_delivery_offering_ids", []))
                for pkg in (buy.get("packages", []) if isinstance(buy, dict) else buy.packages)
            },
        ),
    )
    service.sources.register("reference", Source(), capability_offerings=OFFERINGS)
    seller = Seller(world)
    platform = service.install(seller)
    return world, service, seller, platform


async def control(world: World, service: ReliableReportingService, seller: Seller, body: dict[str, Any]) -> dict[str, Any]:
    op = body.get("op")
    if op == "set_time":
        world.clock.set(at(body["at"]))
        return {"ok": True, "now": world.now_text()}
    if op in ("grant", "revoke"):
        principal = body["principal"]
        instant = at(body["at"])
        authorized = op == "grant"
        previous = world.grants.get(principal)
        if authorized:
            chain_start = instant
            if previous and previous.get("revoked_at") and instant < previous["revoked_at"] + timedelta(days=30):
                chain_start = previous["chain_start"]
            world.grants[principal] = {"authorized": True, "chain_start": chain_start}
        else:
            world.grants[principal] = {**(previous or {"chain_start": instant}), "authorized": False, "revoked_at": instant}
        await service.grants.changed(
            PrincipalRef(None, principal),
            body.get("account_id", ACCOUNT_ID),
            at=instant,
            authorized=authorized,
            allowed_tasks=ALLOWED_TASKS if authorized else None,
            timezone=ACCOUNT_TIMEZONE,
            operator=OPERATOR,
        )
        return {"ok": True}
    if op == "put_buy":
        buy = dict(body["buy"])
        world.buys[buy["media_buy_id"]] = buy
        await service.touch(account_id=body.get("account_id", ACCOUNT_ID))
        await service.drain_subscription_triggers()
        return {"ok": True}
    if op == "run_cycle":
        await service.drain_subscription_triggers()
        turn = await service.run_worker()
        errors = [f"{key}: {value!r}" for key, value in (getattr(turn, "subscription_errors", {}) or {}).items()]
        return {"ok": True, "errors": errors, "obligations_written": getattr(turn, "subscription_obligations_written", None)}
    if op == "obligations":
        engine = service._managed.engine  # noqa: SLF001 - see the module docstring
        owed = await engine.owed_periods(PrincipalRef(None, body["principal"]), body["subscription_id"], body.get("account_id", ACCOUNT_ID))
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
        rows.sort(key=lambda r: (r["period_start"], r["subscription_version"], r["offering_id"].encode(), r["media_buy_id"].encode()))
        return {"ok": True, "rows": rows}
    if op == "account_request":
        return {"ok": True, "request": seller.control_resolve_request(body["request_id"], body["action"])}
    if op == "state":
        return {"ok": True, "now": world.now_text(), "grants": {k: {**v, "chain_start": z(v["chain_start"])} for k, v in world.grants.items() if "chain_start" in v}}
    return {"ok": False, "error": f"unknown op {op!r}"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True)
    args = parser.parse_args()
    world, service, seller, platform = build(at(args.start))

    async def control_route(request: Request) -> JSONResponse:
        try:
            body = await request.json()
            return JSONResponse(await control(world, service, seller, body))
        except Exception as error:  # noqa: BLE001 - every failure goes back to the harness
            log("control error:", repr(error))
            return JSONResponse({"ok": False, "error": f"{type(error).__name__}: {error}"})

    port = free_port()
    ready = {
        "ready": True,
        "sdk": "py",
        "sdk_version": version("adcp"),
        "mcp": f"http://127.0.0.1:{port}/mcp",
        "control": f"http://127.0.0.1:{port}/_interop/control",
    }

    def announce_when_listening() -> None:
        # serve() offers no startup hook on the streamable-http transport, so poll the port.
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                time.sleep(0.1)
        print(json.dumps(ready), flush=True)

    threading.Thread(target=announce_when_listening, daemon=True).start()

    def validate_token(token: str) -> Principal | None:
        return Principal(caller_identity=token, tenant_id=None) if token else None

    serve(
        platform,
        name="interop-reference-seller-py",
        host="127.0.0.1",
        port=port,
        transport="streamable-http",
        auth=BearerTokenAuth(validate_token=validate_token),
        context_factory=auth_context_factory,
        unauthenticated_routes=[Route("/_interop/control", control_route, methods=["POST"])],
        allowed_hosts=[f"127.0.0.1:{port}", "127.0.0.1", "localhost"],
        supported_versions=("3.2", "3.3-beta.3"),
    )


if __name__ == "__main__":
    os.environ.setdefault("ADCP_ENV", "development")
    main()
