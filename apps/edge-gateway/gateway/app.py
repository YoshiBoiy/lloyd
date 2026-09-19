import asyncio
import base64
import hashlib
import hmac
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.responses import JSONResponse
from pydantic import Field
from .capture import FixtureCamera, LocalOCR, OpenCVCamera, PaddleOCRAdapter, preprocess, fully_redacted_image
from .contracts import Strict, Intake, Manifest, Artifact, Approval, Destination
from .privacy import redact
from .storage import LocalStore
from .release import ReleaseClient


class CaptureRequest(Strict):
    caseId: str = Field(min_length=1, max_length=100)
    source: str = Field(default="fixture", pattern="^(fixture|camera|upload)$")
    contentBase64: str | None = Field(default=None, max_length=14_000_000)
    mediaType: str = Field(default="text/plain", pattern="^(text/plain|image/png|image/jpeg)$")


class RedactRequest(Strict):
    destinations: list[Destination] = Field(
        default_factory=lambda: ["lloyd-api", "gemini", "elasticsearch"], min_length=1
    )


class ReleaseRequest(Strict):
    approve: bool = False
    approvedBy: str | None = Field(default=None, min_length=1, max_length=100)


class Settings:
    def __init__(self, root: Path | None = None):
        self.root = root or Path(os.environ.get("EDGE_STORAGE_DIR", "edge-data"))
        self.retention = int(os.environ.get("EDGE_RETENTION_SECONDS", "86400"))
        self.local_token = os.environ.get("EDGE_LOCAL_TOKEN", "")
        self.human_token = os.environ.get("EDGE_HUMAN_APPROVAL_TOKEN", "")
        self.allowed = {"lloyd-api", "gemini", "elasticsearch", "gptzero"}
        self.fixture = Path(__file__).parent.parent / "fixtures" / "inspection.txt"
        self.extra_patterns = []


def create_app(settings: Settings | None = None, release_client: ReleaseClient | None = None, ocr=None):
    settings = settings or Settings()
    store = LocalStore(settings.root, settings.retention)
    ocr = ocr or (PaddleOCRAdapter() if os.environ.get("EDGE_OCR") == "paddle" else LocalOCR())
    release_client = release_client or ReleaseClient(
        os.environ.get("EDGE_BACKEND_URL", "http://127.0.0.1:3001/api/intake/sanitized"),
        os.environ.get("API_TOKEN", ""),
        os.environ.get("RELEASE_APPROVAL_KEY", ""),
    )

    @asynccontextmanager
    async def lifespan(_app):
        async def purge():
            while True:
                store.purge_expired()
                await asyncio.sleep(30)

        task = asyncio.create_task(purge())
        yield
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def authenticate(authorization: str = Header(default="")):
        if settings.local_token and not hmac.compare_digest(authorization, "Bearer " + settings.local_token):
            raise HTTPException(401, "Local authentication required")

    app = FastAPI(title="Lloyd local privacy gateway", lifespan=lifespan, dependencies=[Depends(authenticate)])
    app.state.store = store

    @app.exception_handler(Exception)
    async def generic_error(_request, _exc):
        return JSONResponse(status_code=500, content={"error": "Local operation failed; no sensitive details logged"})

    def load(document_id: UUID):
        try:
            return store.load(str(document_id))
        except FileNotFoundError:
            raise HTTPException(404, "Document not found") from None

    @app.get("/health")
    def health():
        return {"status": "ok", "outbound": "explicit-release-only", "localLLM": False}

    @app.post("/capture")
    def capture(body: CaptureRequest):
        if body.source == "upload":
            try:
                content = base64.b64decode(body.contentBase64 or "", validate=True)
            except ValueError:
                raise HTTPException(400, "Invalid content encoding") from None
            media_type = body.mediaType
        elif body.source == "camera":
            try:
                content, media_type = OpenCVCamera().capture()
            except (ImportError, RuntimeError):
                raise HTTPException(503, "Camera unavailable; choose fixture capture") from None
        else:
            content, media_type = FixtureCamera(settings.fixture).capture()
        if not content or len(content) > 10_000_000:
            raise HTTPException(400, "Content size invalid")
        quality = {"confidence": 1.0, "adapter": "fixture-text"}
        if media_type.startswith("image/"):
            content, quality = preprocess(content)
        document_id = str(uuid4())
        record = {
            "caseId": body.caseId,
            "original": base64.b64encode(content).decode(),
            "mediaType": media_type,
            "sourceHash": hashlib.sha256(content).hexdigest(),
            "quality": quality,
            "retentionUntil": time.time() + settings.retention,
        }
        store.save(document_id, record)
        return {"documentId": document_id, "status": "CAPTURED_LOCAL", "quality": quality}

    @app.post("/documents/{document_id}/ocr")
    def extract(document_id: UUID):
        record = load(document_id)
        if "original" not in record:
            raise HTTPException(410, "Original expired or deleted")
        result = ocr.extract(base64.b64decode(record["original"]), record["mediaType"])
        record["ocr"] = {"text": result.text, "confidence": result.confidence, "adapter": result.adapter}
        # OCR reruns invalidate derivatives and any prior approval.
        for key in ["intake", "tokenMap", "redactedImage"]:
            record.pop(key, None)
        store.save(str(document_id), record)
        return {
            "documentId": str(document_id),
            "status": "OCR_LOCAL",
            "confidence": result.confidence,
            "adapter": result.adapter,
        }

    @app.post("/documents/{document_id}/redact")
    def sanitize(document_id: UUID, body: RedactRequest):
        record = load(document_id)
        if not set(body.destinations) <= settings.allowed or "lloyd-api" not in body.destinations:
            raise HTTPException(403, "Destination not approved")
        if not record.get("ocr", {}).get("text"):
            raise HTTPException(409, "Local OCR text required")
        text, token_map, fields = redact(
            record["ocr"]["text"], record["caseId"], store.key, patterns=settings.extra_patterns
        )
        # Pattern-only detection cannot certify arbitrary names/faces/addresses. Human review is required by default.
        confidence = min(record["ocr"]["confidence"], record["quality"]["confidence"], 0.90)
        manifest = Manifest(
            documentId=document_id,
            caseId=record["caseId"],
            sanitizedSha256=hashlib.sha256(text.encode()).hexdigest(),
            fields=fields,
            destinations=body.destinations,
            confidence=confidence,
            createdAt=datetime.now(timezone.utc),
        )
        intake = Intake(manifest=manifest, artifact=Artifact(text=text))
        record["intake"] = intake.model_dump(mode="json", exclude_none=True)
        record["tokenMap"] = token_map
        if record["mediaType"].startswith("image/"):
            record["redactedImage"] = fully_redacted_image(base64.b64decode(record["original"]))
        store.save(str(document_id), record)
        return {
            "documentId": str(document_id),
            "status": "REDACTED_LOCAL",
            "manifest": record["intake"]["manifest"],
            "requiresApproval": True,
        }

    @app.get("/documents/{document_id}/preview")
    def preview(document_id: UUID):
        record = load(document_id)
        if "intake" not in record:
            raise HTTPException(409, "Redact before preview")
        return {
            "intake": record["intake"],
            "redactedImageBase64": record.get("redactedImage"),
            "requiresApproval": record["intake"]["manifest"]["confidence"] < 0.95,
        }

    @app.post("/documents/{document_id}/release")
    def release(document_id: UUID, body: ReleaseRequest, x_human_approval: str = Header(default="")):
        record = load(document_id)
        if "intake" not in record:
            raise HTTPException(409, "Redact before release")
        payload = Intake.model_validate(record["intake"])
        if not set(payload.manifest.destinations) <= settings.allowed or any(
            f.classification == "local_only" for f in payload.manifest.fields
        ):
            raise HTTPException(403, "Release policy denied")
        if payload.manifest.confidence < 0.95:
            if (
                not body.approve
                or not body.approvedBy
                or not settings.human_token
                or not hmac.compare_digest(settings.human_token, x_human_approval)
            ):
                raise HTTPException(403, "Authenticated human approval required")
            payload.manifest.approval = Approval(approvedBy=body.approvedBy, approvedAt=datetime.now(timezone.utc))
        try:
            result = release_client.send(payload)
        except Exception:
            raise HTTPException(502, "Release failed; sanitized content retained locally") from None
        record["intake"] = payload.model_dump(mode="json", exclude_none=True)
        record["releasedAt"] = datetime.now(timezone.utc).isoformat()
        store.save(str(document_id), record)
        return {"documentId": str(document_id), "status": "RELEASED", "backend": result}

    @app.delete("/documents/{document_id}/original")
    def delete(document_id: UUID):
        load(document_id)
        store.delete_original(str(document_id))
        return {"documentId": str(document_id), "status": "ORIGINAL_DELETED", "manifestRetained": True}

    return app
