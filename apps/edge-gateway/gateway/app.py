import asyncio
import base64
import hashlib
import hmac
import json
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4
from fastapi import FastAPI, Header, HTTPException, Depends, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import Field
from .capture import (
    FixtureCamera,
    LocalOCR,
    OpenCVCamera,
    PageQuadTracker,
    PaddleOCRAdapter,
    annotate_preview_frame,
    camera_available,
    fully_redacted_image,
    preprocess,
)
from .contracts import Strict, Intake, Manifest, Artifact, Approval, Destination
from .page_detect import PageDetector
from .ocr_runtime import RegionOCR
from .privacy import redact
from .quality import QualityPolicy
from .risk import ReviewRiskPolicy
from .storage import LocalStore
from .release import ReleaseClient
from .v2 import install_v2

GATEWAY_VERSION = "0.2.0-v2"


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


def _env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes"}


class Settings:
    def __init__(self, root: Path | None = None):
        env = os.environ.get
        self.root = root or Path(env("EDGE_STORAGE_DIR", "edge-data"))
        self.retention = int(env("EDGE_RETENTION_SECONDS", "86400"))
        self.local_token = env("EDGE_LOCAL_TOKEN", "")
        self.human_token = env("EDGE_HUMAN_APPROVAL_TOKEN", "")
        self.allowed = {"lloyd-api", "gemini", "elasticsearch", "gptzero"}
        self.fixture = Path(__file__).parent.parent / "fixtures" / "inspection.txt"
        self.extra_patterns: list[str] = []
        self.preview_max_seconds = int(env("EDGE_PREVIEW_MAX_SECONDS", "600"))
        # Browser origins allowed to pair directly with this gateway. Empty = deny all cross-origin callers.
        self.allowed_origins = {o.strip() for o in env("EDGE_ALLOWED_ORIGINS", "").split(",") if o.strip()}
        # v2 device identity and signing material (never the backend's provider or database credentials).
        self.device_id = env("EDGE_DEVICE_ID", "")
        self.tenant_id = env("EDGE_TENANT_ID", "")
        self.signing_key_id = env("EDGE_SIGNING_KEY_ID", "")
        self.signing_key = env("EDGE_SIGNING_KEY", "")
        self.v2_enabled = _env_bool("EDGE_V2_ENABLED")
        self.approval_ttl = int(env("EDGE_APPROVAL_TTL_SECONDS", "600"))
        self.clock_tolerance = int(env("EDGE_CLOCK_TOLERANCE_SECONDS", "30"))
        # Reviewer identities: token -> {id, key}. Separate from device credentials.
        self.reviewers: list[dict] = []
        if env("EDGE_REVIEWERS_FILE"):
            for reviewer in json.loads(Path(env("EDGE_REVIEWERS_FILE")).read_text()):
                self.reviewers.append({"token": reviewer["token"], "id": reviewer["id"], "key": reviewer["key"]})
        elif self.human_token and env("EDGE_REVIEWER_ID"):
            self.reviewers.append({"token": self.human_token, "id": env("EDGE_REVIEWER_ID"), "key": env("EDGE_REVIEWER_SIGNING_KEY", "")})
        # Local model artifacts (digest-verified, offline).
        self.classifier_path = env("EDGE_CLASSIFIER_PATH", "")
        self.classifier_digest = env("EDGE_CLASSIFIER_SHA256", "")
        self.detector_path = env("EDGE_DETECTOR_PATH", "")
        self.detector_digest = env("EDGE_DETECTOR_SHA256", "")
        self.page_detector_path = env("EDGE_PAGE_DETECTOR_PATH", "")
        self.page_detector_digest = env("EDGE_PAGE_DETECTOR_SHA256", "")
        self.page_detector_backend = env("EDGE_PAGE_DETECTOR_BACKEND", "auto")
        self.page_score_min = float(env("EDGE_PAGE_SCORE_MIN", "0.35"))
        self.page_input = int(env("EDGE_PAGE_INPUT", "640"))
        self.quality_policy = QualityPolicy(calibrated=_env_bool("EDGE_QUALITY_CALIBRATED"))
        self.review_risk_policy = ReviewRiskPolicy(calibrated=_env_bool("EDGE_REVIEW_RISK_CALIBRATED"))
        self.probe_camera = _env_bool("EDGE_HEALTH_PROBE_CAMERA", True)


def create_app(settings: Settings | None = None, release_client: ReleaseClient | None = None, ocr=None, classifier=None, detector=None, page_detector=None):
    settings = settings or Settings()
    store = LocalStore(settings.root, settings.retention)
    preview_lock = threading.Lock()
    if ocr is None:
        mode = os.environ.get("EDGE_OCR", "tesseract")
        ocr = RegionOCR() if mode == "region" else PaddleOCRAdapter() if mode == "paddle" else LocalOCR()
    release_client = release_client or ReleaseClient(
        os.environ.get("EDGE_BACKEND_URL", "http://127.0.0.1:3001/api/intake/sanitized"),
        os.environ.get("API_TOKEN", ""),
        os.environ.get("RELEASE_APPROVAL_KEY", ""),
        v2_url=os.environ.get("EDGE_BACKEND_V2_URL"),
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
    app.state.page_detector = page_detector or PageDetector(
        settings.page_detector_path, settings.page_detector_digest,
        settings.page_detector_backend, settings.page_score_min, settings.page_input,
    )
    app.state.store = store
    app.state.settings = settings

    @app.exception_handler(Exception)
    async def generic_error(_request, _exc):
        return JSONResponse(status_code=500, content={"error": "Local operation failed; no sensitive details logged"})

    PRIVILEGED_SUFFIXES = ("/review", "/preview", "/preview/stream")
    FORWARDING_HEADERS = ("via", "x-forwarded-for", "x-forwarded-host", "forwarded")
    CORS_HEADERS = "authorization, content-type, x-human-approval"

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        """Explicit origins, no-store responses, and local-only raw preview/review (TDD §4, §8)."""
        origin = request.headers.get("origin")
        if origin is not None and origin not in settings.allowed_origins:
            return JSONResponse(status_code=403, content={"error": "Origin not paired with this gateway"}, headers={"cache-control": "no-store"})
        if request.method == "OPTIONS" and origin is not None:
            return Response(
                status_code=204,
                headers={
                    "access-control-allow-origin": origin,
                    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
                    "access-control-allow-headers": CORS_HEADERS,
                    "access-control-max-age": "600",
                    "vary": "origin",
                    "cache-control": "no-store",
                },
            )
        path = request.url.path
        if path.endswith(PRIVILEGED_SUFFIXES) and any(h in request.headers for h in FORWARDING_HEADERS):
            return JSONResponse(
                status_code=403,
                content={"error": "Raw preview and local review are served only to a directly paired local client"},
                headers={"cache-control": "no-store"},
            )
        response = await call_next(request)
        response.headers["cache-control"] = "no-store, no-cache"
        response.headers["x-content-type-options"] = "nosniff"
        response.headers["referrer-policy"] = "no-referrer"
        if origin is not None:
            response.headers["access-control-allow-origin"] = origin
            response.headers["access-control-expose-headers"] = "content-type"
            response.headers["vary"] = "origin"
        return response

    def load(document_id: UUID):
        try:
            return store.load(str(document_id))
        except FileNotFoundError:
            raise HTTPException(404, "Document not found") from None

    @app.get("/health")
    def health():
        """Per-capability device state. The former single `localLLM` flag is replaced by
        classifier and detector readiness with model identity and artifact digests."""
        classifier = app.state.classifier.capabilities()
        detector = app.state.detector.capabilities()
        return {
            "status": "ok",
            "version": GATEWAY_VERSION,
            "outbound": "explicit-release-only",
            "deviceId": settings.device_id or None,
            "tenantId": settings.tenant_id or None,
            "v2Enabled": settings.v2_enabled,
            "capabilities": {
                "camera": camera_available() if settings.probe_camera else None,
                "ocr": ocr.capabilities() if hasattr(ocr, "capabilities") else {"adapter": type(ocr).__name__, "ready": getattr(ocr, "available", lambda: True)()},
                "classifier": classifier,
                "detector": detector,
                "pageDetector": app.state.page_detector.capabilities(),
                "qualityPolicy": settings.quality_policy.as_dict(),
                "reviewRiskPolicy": settings.review_risk_policy.as_dict(),
                "privacyPolicyVersion": "privacy-v2-text-only",
                "imageRedaction": "TEXT_LAYOUT_ONLY",
                # Enumeration is metadata-only, which is what lets the workspace count local
                # work over the same-origin proxy while review stays directly paired.
                "enumeration": {"route": "/v2/intakes", "indexed": store.index_count(), "rebuilds": store.index_rebuilds},
                "pairing": {"configured": bool(settings.local_token), "reviewers": len(settings.reviewers), "allowedOrigins": sorted(settings.allowed_origins)},
            },
        }

    @app.get("/preview/stream")
    def preview_stream():
        """Explicit, transient camera view; frames never enter capture, OCR, or storage.

        Each JPEG is annotated on the RDK with the detected page quadrilateral so the
        operator sees live document edges. The overlay is not written to captured pages.
        """
        if not settings.local_token:
            raise HTTPException(403, "Raw preview requires a paired local client")
        if not preview_lock.acquire(blocking=False):
            raise HTTPException(409, "Camera preview already active")
        try:
            import cv2

            camera = cv2.VideoCapture(int(os.environ.get("EDGE_CAMERA_INDEX", "0")))
            if not camera.isOpened():
                camera.release()
                raise RuntimeError("Camera unavailable")
        except (ImportError, RuntimeError):
            preview_lock.release()
            raise HTTPException(503, "Camera preview unavailable") from None

        def frames():
            tracker = PageQuadTracker()
            try:
                deadline = time.monotonic() + max(1, settings.preview_max_seconds)
                while time.monotonic() < deadline:
                    ok, frame = camera.read()
                    if not ok or frame is None:
                        break
                    annotated = annotate_preview_frame(frame, tracker, app.state.page_detector)
                    ok, encoded = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 70])
                    if not ok:
                        break
                    jpeg = encoded.tobytes()
                    yield (
                        b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                        + str(len(jpeg)).encode()
                        + b"\r\n\r\n"
                        + jpeg
                        + b"\r\n"
                    )
                    time.sleep(1 / 15)
            finally:
                camera.release()
                preview_lock.release()

        return StreamingResponse(
            frames(),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"cache-control": "no-store, no-cache", "x-content-type-options": "nosniff"},
        )

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
        quality = {"confidence": 1.0, "adapter": "fixture-text", "status": "PASS", "reasons": []}
        original = content
        if media_type.startswith("image/"):
            content, quality = preprocess(content, settings.quality_policy, app.state.page_detector)
            # v1 callers read a scalar confidence; derive it from the bounded status.
            quality["confidence"] = {"PASS": 0.9, "REVIEW": 0.4, "RECAPTURE": 0.0}[quality["status"]]
        document_id = str(uuid4())
        record = {
            "caseId": body.caseId,
            "original": base64.b64encode(original).decode(),
            "corrected": base64.b64encode(content).decode(),
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
        result = ocr.extract(base64.b64decode(record.get("corrected", record["original"])), record["mediaType"])
        record["ocr"] = {"text": result.text, "confidence": result.confidence, "adapter": result.adapter, "lines": result.lines}
        # OCR reruns invalidate derivatives and any prior approval.
        for key in ["intake", "tokenMap", "redactedImage"]:
            record.pop(key, None)
        store.save(str(document_id), record)
        return {
            "documentId": str(document_id),
            "status": "OCR_LOCAL",
            "confidence": result.confidence,
            "adapter": result.adapter,
            "lineCount": len(result.lines),
        }

    @app.post("/documents/{document_id}/redact")
    def sanitize(document_id: UUID, body: RedactRequest):
        record = load(document_id)
        if not set(body.destinations) <= settings.allowed or "lloyd-api" not in body.destinations:
            raise HTTPException(403, "Destination not approved")
        if not record.get("ocr", {}).get("text"):
            raise HTTPException(409, "Local OCR text required")
        # Redact line by line so a label pattern cannot consume neighbouring safe lines.
        lines = record["ocr"].get("lines") or [{"text": record["ocr"]["text"]}]
        safe_lines, token_map, fields = [], {}, []
        for line in lines:
            safe, tokens, detected = redact(line["text"], record["caseId"], store.key, patterns=settings.extra_patterns)
            safe_lines.append(safe)
            token_map.update(tokens)
            for f in detected:
                fields.append({**f, "path": f'field_{len(fields)}.{f["path"].split(".", 1)[1]}'})
        text = "\n".join(safe_lines)
        # Pattern-only detection cannot certify arbitrary names/faces/addresses. Human review is required by default.
        confidence = min(record["ocr"]["confidence"], record["quality"].get("confidence", 0.4), 0.90)
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

    install_v2(app, settings, store, ocr, release_client, classifier=classifier, detector=detector)
    return app
