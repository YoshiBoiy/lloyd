"""Release contract v2 over real HTTP: Python gateway -> Node API -> inbox association -> typed extraction.

Uses only synthetic fixture data and a classifier trained in-process; the semantic detector is a
stand-in so the smoke test needs no model download. Verifies: signed approval accepted once and
deduplicated on retry, canaries absent from every backend representation, candidates ranked from
hints only, audited association, provenance-bound Gemini fixture extraction.
"""

import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "edge-gateway"))
from gateway.app import Settings, create_app
from gateway.inference import LocalClassifier
from gateway.privacy import Span
from gateway.release import ReleaseClient
from gateway.train import train, write_model

DEVICE_KEY = "smoke-device-signing-key-0123456789abcdef01234"
REVIEWER_KEY = "smoke-reviewer-signing-key-0123456789abcdef012"
CANARIES = ["Jane Canary", "canary.sensitive@example.test", "416-555-0188", "POL-CANARY-9921", "123 Canary Lane"]
CORPUS = {
    "inspection_report": "inspection report site visit sprinkler fire exits roof condition housekeeping recommendations observed building",
    "loss_run": "loss run claim paid reserve incurred loss date valuation carrier claimant status closed",
    "statement_of_values": "statement of values location building tiv contents business income construction year built sprinklered",
    "application": "application applicant requested coverage effective date signature broker questions limits deductible",
    "policy_document": "policy declarations insuring agreement exclusions conditions endorsements premium term named insured",
    "correspondence": "dear regards letter email follow up thank you attached please advise sincerely",
    "mixed": "inspection report loss run statement of values application policy declarations letter attached",
}
PAGE = (
    CORPUS["inspection_report"]
    + "\nContact: Jane Canary\nEmail: canary.sensitive@example.test\nPhone: 416-555-0188\nPolicy: POL-CANARY-9921\n"
    "Home address: 123 Canary Lane, Toronto ON\nYear built: 2016\nConstruction: masonry noncombustible\n"
    "Primary risk state: PA\nTIV: 72000000 USD\nNarrative: Jane Canary walked the site; sprinkler equipment maintained."
)


class StandInDetector:
    ready = True

    def capabilities(self):
        return {"ready": True, "modelId": "smoke-ner", "artifactDigest": "0" * 64, "runtimeVersion": "smoke", "error": None}

    def detect(self, text):
        spans, start = [], 0
        while (index := text.find("Jane Canary", start)) >= 0:
            spans.append(Span(index, index + len("Jane Canary"), "semantic_entity", "redacted", "local-semantic-v1"))
            start = index + 1
        return spans


with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
env = {
    **os.environ,
    "PORT": str(port),
    "HOST": "127.0.0.1",
    "API_TOKEN": "smoke-api",
    "EDGE_TENANT_ID": "tenant-smoke",
    "EDGE_DEVICE_ID": "rdk-x5-smoke",
    "EDGE_SIGNING_KEY_ID": "smoke-key-1",
    "EDGE_SIGNING_KEY": DEVICE_KEY,
    "EDGE_REVIEWER_ID": "reviewer-smoke",
    "EDGE_REVIEWER_SIGNING_KEY": REVIEWER_KEY,
    "PLANNER_PROVIDER": "scripted",
}
for key in ["FEDERATO_CLIENT_ID", "FEDERATO_CLIENT_SECRET", "FEDERATO_MAPPING_FILE", "MONGODB_URI", "ELASTICSEARCH_URL",
            "TIGER_DATABASE_URL", "OPENAI_API_KEY", "GEMINI_API_KEY", "GPTZERO_API_KEY", "EDGE_V2_POLICY_FILE", "FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_AGENT_ID", "FOUNDRY_API_KEY"]:
    env[key] = ""  # empty beats .env loading in the child process
server = subprocess.Popen(["node", "dist/apps/api/src/server.js"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    url = f"http://127.0.0.1:{port}"
    reviewer = {"Authorization": "Bearer smoke-api", "x-reviewer-id": "reviewer-smoke"}
    with httpx.Client(base_url=url, headers={"Authorization": "Bearer smoke-api"}, timeout=10) as api:
        for _ in range(100):
            try:
                if api.get("/health").status_code == 200:
                    break
            except httpx.ConnectError:
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("API did not start")
        boot = api.post("/api/bootstrap").json()
        assert boot["services"]["intakeV2"] == "ENABLED", boot["services"]
        assert boot["services"]["plannerDetail"]["status"] == "scripted", boot["services"]
        assert api.post("/api/ingest").json()["created"] == 56

        with tempfile.TemporaryDirectory() as directory:
            rows = [{"label": label, "text": f"{text} sample {i}"} for label, text in CORPUS.items() for i in range(3)]
            model_path = Path(directory) / "model.json"
            digest = write_model(train(rows, threshold=0.5, min_coverage=0.2), model_path)
            settings = Settings(Path(directory) / "store")
            settings.local_token = "smoke-pairing"
            settings.human_token = "smoke-human"
            settings.reviewers = [{"token": "smoke-human", "id": "reviewer-smoke", "key": REVIEWER_KEY}]
            settings.device_id, settings.tenant_id, settings.signing_key_id = "rdk-x5-smoke", "tenant-smoke", "smoke-key-1"
            settings.signing_key = DEVICE_KEY
            settings.v2_enabled = True
            settings.probe_camera = False
            release = ReleaseClient(url + "/api/intake/sanitized", "smoke-api", v2_url=url + "/api/intake/v2")
            app = create_app(settings, release, classifier=LocalClassifier(str(model_path), digest), detector=StandInDetector())
            with TestClient(app, headers={"authorization": "Bearer smoke-pairing"}) as edge:
                health = edge.get("/health").json()
                assert health["capabilities"]["classifier"]["ready"] and "localLLM" not in health, health
                # Forwarded requests may not reach raw preview or local review.
                assert edge.get("/v2/intakes/00000000-0000-4000-8000-000000000000/review", headers={"via": "1.1 proxy"}).status_code == 403

                start = edge.post("/v2/intakes", json={"caseId": None, "destinations": ["lloyd-api", "gemini", "elasticsearch"]}).json()
                intake_id = start["intakeId"]
                page = edge.post(
                    f"/v2/intakes/{intake_id}/pages",
                    json={"source": "upload", "mediaType": "text/plain", "contentBase64": base64.b64encode(PAGE.encode()).decode()},
                )
                assert page.status_code == 200, page.text
                analyzed = edge.post(f"/v2/intakes/{intake_id}/analyze").json()
                assert analyzed["stage"] == "REVIEW_READY", analyzed
                assert analyzed["classification"]["documentType"] == "inspection_report"
                assert analyzed["matchHints"]["riskState"] == "PA" and analyzed["matchHints"]["tivBucket"] == "10m_100m"
                review = edge.get(f"/v2/intakes/{intake_id}/review").json()
                released_text = json.dumps(review["artifacts"])
                assert all(c not in released_text for c in CANARIES), released_text
                assert "Year built: 2016" in released_text and "masonry noncombustible" in released_text

                # Approval binds the exact reviewed revision; release is accepted once and deduplicated on retry.
                approved = edge.post(
                    f"/v2/intakes/{intake_id}/approve",
                    json={"revision": analyzed["revision"], "acknowledgedQuality": True},
                    headers={"x-human-approval": "smoke-human"},
                )
                assert approved.status_code == 200, approved.text
                released = edge.post(f"/v2/intakes/{intake_id}/release")
                assert released.status_code == 200, released.text
                receipt = released.json()["receipt"]
                assert receipt["status"] == "ACCEPTED" and receipt["association"] is None, receipt
                again = edge.post(f"/v2/intakes/{intake_id}/release").json()
                assert again["stage"] == "ACCEPTED" and again["receipt"]["digest"] == receipt["digest"]

        # Backend: inbox holds sanitized text only; candidates from hints; association audited; extraction typed.
        inbox = api.get("/api/intakes", headers=reviewer).json()
        assert inbox["total"] == 1 and inbox["items"][0]["status"] == "AWAITING_ASSOCIATION", inbox
        assert all(c not in json.dumps(inbox) for c in CANARIES)
        assert api.get("/api/intakes").status_code == 403
        candidates = api.get(f"/api/intakes/{intake_id}/candidates", headers=reviewer).json()
        assert candidates["sufficientHints"] and all(c["reasons"] for c in candidates["candidates"]), candidates
        associated = api.post(
            f"/api/intakes/{intake_id}/association", headers=reviewer, json={"caseId": "demo-001", "reason": "smoke association"}
        )
        assert associated.status_code == 200, associated.text
        intake = associated.json()["intake"]
        assert intake["association"]["source"] == "REVIEWER"
        assert [a["action"] for a in intake["audit"]] == ["RELEASE_ACCEPTED", "ASSOCIATED"]
        gemini = intake["processing"]["gemini"]
        assert gemini["status"] == "CANDIDATE_UNVERIFIED" and gemini["classificationAgreement"] == "AGREE", gemini
        assert any(r["yearBuilt"] == 2016 for r in gemini["extraction"]["sovRows"]), gemini["extraction"]
        assert any(r["tiv"] == 72_000_000 for r in gemini["extraction"]["sovRows"])
        assert intake["processing"]["elasticsearch"]["status"] in {"INDEXED", "UNAVAILABLE"}
        processing = api.get(f"/api/intakes/{intake_id}/processing", headers=reviewer).json()
        assert processing["status"] in {"PROCESSED", "PROCESSED_WITH_WARNINGS"}, processing
        assert all(c not in json.dumps(intake) for c in CANARIES)
    print("PASS: v2 gateway -> API over HTTP: signed approval, dedup, inbox, hint candidates, audited association, typed extraction")
finally:
    server.terminate()
    server.wait(timeout=5)
