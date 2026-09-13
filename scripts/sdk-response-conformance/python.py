"""Actual Python SDK server helpers over the MCP SDK's in-memory transport."""
import asyncio
import importlib.metadata
import json
import platform
import sys

from adcp.server import ADCPHandler, create_mcp_server
from adcp.server.helpers import adcp_error
from adcp.exceptions import ADCPTaskError
from adcp.types import Error
from adcp.server.responses import products_response
from adcp.validation.client_hooks import ValidationHookConfig
from mcp import Client, types
from mcp.client._memory import InMemoryTransport

async def main():
    with open(sys.argv[1]) as stream:
        plan = json.load(stream)
    active = None
    called = False
    served = None

    class Seller(ADCPHandler):
        advertised_tools = {'get_products', 'list_products', 'get_adcp_capabilities'}
        _adcp_version = plan['protocol']['version']

        async def get_products(self, params, context=None):
            nonlocal called, served
            called = True
            served = context.resolved_adcp_version if context else None
            if active['kind'] == 'error':
                error_payload = adcp_error(active['code'], 'Conformance fixture', recovery=active.get('recovery'))
                raise ADCPTaskError(operation='get_products', errors=[Error.model_validate(value) for value in error_payload['errors']])
            return products_response([], cache_scope='public', wholesale_feed_version='fixture-feed')

        async def list_products(self, params, context=None):
            nonlocal called, served
            called = True
            served = context.resolved_adcp_version if context else None
            return {'outcome': 'listed', 'products': [], 'feed_version': 'fixture-feed', 'cache_scope': 'public'}

    server = create_mcp_server(Seller(), validation=ValidationHookConfig(requests='strict', responses='off'))
    observations = []
    # Explicit transport + legacy handshake prevents the client's direct-call shortcut.
    async with Client(InMemoryTransport(server), mode='legacy') as client:
        listing = await client.list_tools()
        advertised = [tool.name for tool in listing.tools]
        for probe in plan['cases']:
            active = probe
            called = False
            served = None
            if probe['tool'] not in advertised:
                observations.append({'id': probe['id'], 'skip': 'Not advertised by configured SDK server'})
                continue
            try:
                # Use the public request API to retain invalid wire output, then run
                # the same output check as Client.call_tool without losing that output.
                result = await client.session.send_request(
                    types.CallToolRequest(params=types.CallToolRequestParams(name=probe['tool'], arguments=probe['request'])),
                    types.CallToolResult,
                )
                validation_error = None
                if not result.is_error:
                    try:
                        await client.session.validate_tool_result(probe['tool'], result)
                    except Exception as error:
                        validation_error = str(error).split('\n')[0]
                observations.append({'id': probe['id'], 'handler_called': called, 'handler_served_version': served, 'sdk_response_validation_error': validation_error, 'result': result.model_dump(mode='json', by_alias=True, exclude_none=True)})
            except Exception as error:
                observations.append({'id': probe['id'], 'handler_called': called, 'transport_error': str(error)[:2000], 'exception_type': type(error).__name__})
    print(json.dumps({'sdk': {'language': 'python', 'package': 'adcp', 'version': importlib.metadata.version('adcp'), 'runtime': platform.python_version(), 'mcp': importlib.metadata.version('mcp')}, 'transport': 'MCP InMemoryTransport + create_mcp_server', 'advertised_tools': advertised, 'observations': observations}, indent=2))

asyncio.run(main())
