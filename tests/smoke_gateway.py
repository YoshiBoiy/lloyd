"""Real HTTP Python gateway -> Node API interoperability, using only synthetic fixture data."""

import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from gateway.app import Settings, create_app
from gateway.release import ReleaseClient

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
env = {
    **os.environ,
    "PORT": str(port),
    "HOST": "127.0.0.1",
    "API_TOKEN": "smoke-api",
    "RELEASE_APPROVAL_KEY": "smoke-paired",
}
# Isolate smoke test from any developer-configured live service.
for key in [
    "FEDERATO_CLIENT_ID",
    "FEDERATO_CLIENT_SECRET",
    "FEDERATO_MAPPING_FILE",
    "MONGODB_URI",
    "ELASTICSEARCH_URL",
    "TIGER_DATABASE_URL",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GPTZERO_API_KEY",
]:
    env.pop(key, None)
server = subprocess.Popen(
    ["node", "dist/apps/api/src/server.js"],
    env=env,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
)
try:
    url = f"http://127.0.0.1:{port}"
    with httpx.Client(
        base_url=url, headers={"Authorization": "Bearer smoke-api"}, timeout=10
    ) as api:
        for _ in range(100):
            try:
                if api.get("/health").status_code == 200:
                    break
            except httpx.ConnectError:
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("API did not start")
        assert api.post("/api/ingest").json()["created"] == 56
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory))
            settings.human_token = "smoke-human"
            client = ReleaseClient(
                url + "/api/intake/sanitized", "smoke-api", "smoke-paired"
            )
            with TestClient(create_app(settings, client)) as edge:
                doc = edge.post("/capture", json={"caseId": "demo-001"}).json()[
                    "documentId"
                ]
                assert edge.post(f"/documents/{doc}/ocr").status_code == 200
                assert edge.post(f"/documents/{doc}/redact", json={}).status_code == 200
                assert (
                    edge.post(f"/documents/{doc}/release", json={}).status_code == 403
                )
                response = edge.post(
                    f"/documents/{doc}/release",
                    json={"approve": True, "approvedBy": "smoke-reviewer"},
                    headers={"x-human-approval": "smoke-human"},
                )
                assert response.status_code == 200, response.text
                assert (
                    response.json()["backend"]["processing"]["gemini"]["status"]
                    == "CANDIDATE_UNVERIFIED"
                )
                manifest = api.get(f"/api/intake/{doc}/manifest")
                assert manifest.status_code == 200
                assert "canary.sensitive@example.test" not in manifest.text
        print(
            "PASS: real HTTP gateway -> API, signature, hash, manifest, sanitized Gemini fixture"
        )
finally:
    server.terminate()
    server.wait(timeout=5)
