import base64
import hashlib
import io
import json
import time
from uuid import uuid4
import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from gateway.app import create_app, Settings
from gateway.capture import LocalOCR, fully_redacted_image
from gateway.privacy import redact, Span
from gateway.release import ReleaseClient
from gateway.storage import LocalStore

CANARIES = [
    "Jane Canary",
    "canary.sensitive@example.test",
    "416-555-0188",
    "POL-CANARY-9921",
    "123-45-6789",
    "sk-canarysecret0123456789",
    "123 Canary Lane",
    "1980-02-03",
]


@pytest.fixture
def client(tmp_path):
    settings = Settings(tmp_path)
    settings.human_token = "human-token"
    outbound = []

    def send(request):
        outbound.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "ACCEPTED"})

    release = ReleaseClient(
        "http://localhost:3001/api/intake/sanitized", approval_key="paired-key", transport=httpx.MockTransport(send)
    )
    app = create_app(settings, release)
    with TestClient(app) as test:
        yield test, app.state.store, outbound


def scan(test):
    captured = test.post("/capture", json={"caseId": "demo-001"}).json()
    document_id = captured["documentId"]
    assert test.post(f"/documents/{document_id}/ocr").status_code == 200
    assert test.post(f"/documents/{document_id}/redact", json={}).status_code == 200
    return document_id


def test_capture_redact_preview_no_network_and_no_canaries(client):
    test, store, outbound = client
    document_id = scan(test)
    preview = test.get(f"/documents/{document_id}/preview").json()
    for value in CANARIES:
        assert value not in json.dumps(preview)
        assert value.encode() not in store.path(document_id).read_bytes()
    assert not outbound
    assert preview["requiresApproval"]
    assert "Year built: 2016" in preview["intake"]["artifact"]["text"]


def test_low_confidence_and_forged_approval_blocked(client):
    test, _, outbound = client
    document_id = scan(test)
    assert test.post(f"/documents/{document_id}/release", json={}).status_code == 403
    assert (
        test.post(f"/documents/{document_id}/release", json={"approve": True, "approvedBy": "reviewer"}).status_code
        == 403
    )
    assert not outbound


def test_explicit_authenticated_release_only_path(client):
    test, _, outbound = client
    document_id = scan(test)
    r = test.post(
        f"/documents/{document_id}/release",
        json={"approve": True, "approvedBy": "reviewer"},
        headers={"x-human-approval": "human-token"},
    )
    assert r.status_code == 200
    assert len(outbound) == 1
    for value in CANARIES:
        assert value not in json.dumps(outbound)
    assert "tokenMap" not in json.dumps(outbound)
    data = outbound[0]
    assert data["manifest"]["sanitizedSha256"] == hashlib.sha256(data["artifact"]["text"].encode()).hexdigest()


def test_destinations_fail_closed(client):
    test, _, outbound = client
    doc = test.post("/capture", json={"caseId": "demo-001"}).json()["documentId"]
    test.post(f"/documents/{doc}/ocr")
    assert test.post(f"/documents/{doc}/redact", json={"destinations": ["openai"]}).status_code == 403
    assert not outbound


def test_tokens_stable_within_case_unlinkable_across_cases():
    text = "Policy: ABC123\nContact: Jane Canary"
    first = redact(text, "a", b"secret")[0]
    assert first == redact(text, "a", b"secret")[0]
    assert first != redact(text, "b", b"secret")[0]
    assert "ABC123" not in first and "Jane Canary" not in first


def test_extension_spans_union_and_cannot_unredact():
    class Detector:
        def detect(self, text):
            return [Span(0, 5, "name"), Span(3, len(text), "signature")]

    assert redact("CANARY SENSITIVE", "a", b"key", extra=[Detector()])[0] == "[REDACTED]"


def test_delete_original_preserves_manifest(client):
    test, store, _ = client
    doc = scan(test)
    assert test.delete(f"/documents/{doc}/original").status_code == 200
    data = store.load(doc)
    assert all(k not in data for k in ["original", "ocr", "tokenMap"])
    assert "manifest" in data["intake"]
    assert test.post(f"/documents/{doc}/ocr").status_code == 410


def test_retention_purge_preserves_audit(tmp_path):
    store = LocalStore(tmp_path, 1)
    doc = str(uuid4())
    store.save(
        doc,
        {
            "retentionUntil": time.time() - 1,
            "original": "CANARY",
            "tokenMap": {"a": "CANARY"},
            "intake": {"manifest": {"documentId": doc}},
        },
    )
    assert store.purge_expired() == 1
    assert store.load(doc) == {
        "retentionUntil": pytest.approx(time.time() - 1, abs=2),
        "originalDeleted": True,
        "intake": {"manifest": {"documentId": doc}},
    }


def test_image_preview_has_no_original_pixels():
    out = io.BytesIO()
    Image.new("RGB", (10, 10), "red").save(out, format="PNG")
    image = Image.open(io.BytesIO(base64.b64decode(fully_redacted_image(out.getvalue()))))
    assert image.getextrema() == ((0, 0), (0, 0), (0, 0))


def test_fixture_ocr_needs_no_external_dependency():
    assert LocalOCR().extract(b"Year built: 2016", "text/plain").text == "Year built: 2016"


def test_release_destination_security():
    with pytest.raises(ValueError):
        ReleaseClient("http://unapproved.example/api")
    with pytest.raises(ValueError):
        ReleaseClient("https://user:secret@example.com/api")


def test_path_traversal_is_rejected(client):
    test, _, _ = client
    assert test.get("/documents/not-a-uuid/preview").status_code == 422


def test_gateway_produces_cross_language_contract_fixture(client, tmp_path):
    test, _, _ = client
    doc = scan(test)
    value = test.get(f"/documents/{doc}/preview").json()["intake"]
    assert set(value) == {"manifest", "artifact"}
    assert value["artifact"]["mediaType"] == "text/plain"
    assert value["manifest"]["version"] == 1


def test_network_failure_keeps_local_document(tmp_path):
    settings = Settings(tmp_path)
    settings.human_token = "human"

    def offline(_request):
        raise httpx.ConnectError("offline")

    release = ReleaseClient(
        "http://localhost:3001/api/intake/sanitized", approval_key="paired", transport=httpx.MockTransport(offline)
    )
    app = create_app(settings, release)
    with TestClient(app) as test:
        doc = scan(test)
        assert (
            test.post(
                f"/documents/{doc}/release",
                json={"approve": True, "approvedBy": "human"},
                headers={"x-human-approval": "human"},
            ).status_code
            == 502
        )
        assert test.get(f"/documents/{doc}/preview").status_code == 200
