"""Run the gateway. Loopback by default; binding to the LAN requires a pairing token so an unpaired
browser can never reach raw preview or review (TDD §4)."""

import os

import uvicorn

from .app import create_app

host = os.environ.get("EDGE_BIND_HOST", "127.0.0.1")
port = int(os.environ.get("EDGE_BIND_PORT", "8001"))
if host not in {"127.0.0.1", "localhost", "::1"} and not os.environ.get("EDGE_LOCAL_TOKEN"):
    raise SystemExit("EDGE_LOCAL_TOKEN is required when binding beyond loopback")
uvicorn.run(create_app(), host=host, port=port, access_log=False, server_header=False)
