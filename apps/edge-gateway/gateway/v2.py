"""Immutable local v2 intake sessions (TDD v2 §5.5, §6, §8).

State machine:
  CAPTURED -> PREPROCESSED -> OCR_COMPLETE -> ANALYZED -> SANITIZED -> REVIEW_READY
  -> APPROVED -> RELEASE_PENDING -> ACCEPTED
Branches: RECAPTURE_REQUIRED, BLOCKED, LOCAL_MODEL_UNAVAILABLE, RELEASE_FAILED, ORIGINAL_EXPIRED.

Every recomputation bumps the revision and discards any approval. Only the
release module is allowed outbound, and only for the exact approved envelope.
"""
import base64
import hashlib
import hmac
import json
import threading
import time
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

import jsonschema
import rfc8785
from fastapi import Header, HTTPException
from pydantic import Field

from .capture import preprocess
from .contracts import Destination, Strict
from .hints import build_hints
from .inference import LocalClassifier, MODEL_ID_RE, SemanticDetector, unavailable_classification
from .privacy import Span, redact
from .quality import PageAssessment, assess_ocr, summarize
from .release import ReleaseConflict
from .risk import assess as assess_review_risk, semantic_only

SCHEMA = json.loads(Path(__file__).with_name("intake-v2.schema.json").read_text())
PRIVACY_POLICY_VERSION = "privacy-v2-text-only"
LIMITATIONS = ["TEXT_LAYOUT_ONLY", "NO_IMAGE_OR_TABLE_STRUCTURE_RELEASE", "ACCEPTANCE_GATES_REQUIRED"]
DOCUMENT_TYPES = {"inspection_report", "loss_run", "statement_of_values", "application", "policy_document", "correspondence", "mixed", "unknown"}
MAX_PAGES, MAX_BLOCKS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_ENVELOPE_BYTES = 20, 2000, 2_000_000, 10_000_000, 25_000_000


def stamp(moment: datetime | None = None) -> str:
    moment = moment or datetime.now(timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_stamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def signature(manifest: dict, key: str, role: str = "device") -> str:
    return hmac.new(key.encode(), f"lloyd:intake:v2:{role}\0".encode() + rfc8785.dumps(manifest), hashlib.sha256).hexdigest()


def validate_envelope(envelope: dict) -> None:
    """Schema, canonical-form, artifact-descriptor and size checks. Mirrors the backend."""
    jsonschema.Draft7Validator(SCHEMA, format_checker=jsonschema.FormatChecker()).validate(envelope)
    canonical = rfc8785.dumps(envelope)  # Rejects non-finite numbers and invalid Unicode.
    descriptors = envelope["manifest"]["artifacts"]
    artifacts = envelope["artifacts"]
    if len({a["id"] for a in artifacts}) != len(artifacts) or len(descriptors) != len(artifacts):
        raise ValueError("Artifact mismatch")
    by_id = {a["id"]: a for a in artifacts}
    total = 0
    for desc in descriptors:
        artifact = by_id.get(desc["id"])
        if artifact is None:
            raise ValueError("Artifact mismatch")
        raw = artifact["text"].encode()
        if desc["sha256"] != hashlib.sha256(raw).hexdigest() or desc["byteLength"] != len(raw):
            raise ValueError("Artifact mismatch")
        total += len(raw)
    if total > MAX_TEXT_BYTES or len(canonical) > MAX_ENVELOPE_BYTES:
        raise ValueError("Release size exceeded")
    m = envelope["manifest"]
    if m["matchHints"]["documentType"] != m["classification"]["documentType"]:
        raise ValueError("Hint/classification mismatch")
    if m["classification"]["attributes"]["pageCount"] != m["quality"]["pageCount"]:
        raise ValueError("Page count mismatch")
    blocks = {d["blockId"] for d in descriptors}
    if any(e not in blocks for e in m["classification"]["evidenceIds"]):
        raise ValueError("Evidence must reference released blocks")


def sanitize_classification(classification: dict, evidence_ids: list[str], page_count: int) -> dict:
    """Every model-produced string is coerced into the closed schema; anything else becomes UNAVAILABLE."""
    fallback = unavailable_classification(evidence_ids, page_count)
    try:
        if classification["status"] not in {"CLASSIFIED", "ABSTAINED", "UNAVAILABLE"}:
            return fallback
        if classification["documentType"] not in DOCUMENT_TYPES or not MODEL_ID_RE.fullmatch(str(classification["modelId"])):
            return fallback
        alternatives = [
            {"label": a["label"], "confidence": round(float(a["confidence"]), 6)}
            for a in classification.get("alternatives", [])[:8]
            if a["label"] in DOCUMENT_TYPES and 0 <= float(a["confidence"]) <= 1
        ]
        attributes = classification.get("attributes", {})
        return {
            "status": classification["status"],
            "documentType": classification["documentType"],
            "confidence": round(min(1.0, max(0.0, float(classification["confidence"]))), 6),
            "calibration": classification["calibration"] if classification.get("calibration") in {"CALIBRATED", "UNCALIBRATED"} else "UNCALIBRATED",
            "alternatives": alternatives,
            "attributes": {
                "language": attributes.get("language") if attributes.get("language") in {"en", "unknown"} else "unknown",
                "pageCount": page_count,
                "hasTables": bool(attributes.get("hasTables", False)),
                "lineOfBusiness": attributes.get("lineOfBusiness") if attributes.get("lineOfBusiness") in {"property", "casualty", "mixed", "unknown"} else "unknown",
            },
            "modelId": str(classification["modelId"]),
            "artifactDigest": classification.get("artifactDigest"),
            "runtimeVersion": str(classification.get("runtimeVersion", "unknown"))[:100],
            "latencyMs": round(min(3_600_000.0, max(0.0, float(classification.get("latencyMs", 0)))), 3),
            "evidenceIds": evidence_ids[:MAX_BLOCKS],
        }
    except (KeyError, TypeError, ValueError):
        return fallback


STAGES = (
    "CAPTURED",
    "PREPROCESSED",
    "OCR_COMPLETE",
    "RECAPTURE_REQUIRED",
    "ANALYZED",
    "LOCAL_MODEL_UNAVAILABLE",
    "SANITIZED",
    "REVIEW_READY",
    "APPROVED",
    "RELEASE_PENDING",
    "RELEASE_FAILED",
    "ACCEPTED",
    "BLOCKED",
    "ORIGINAL_EXPIRED",
)


def page_count(record: dict) -> int:
    """Pages survive original deletion as a count only, so a listed intake keeps its shape."""
    return int(record.get("pageCount", len(record.get("pages", []))))


def intake_summary(record: dict) -> dict | None:
    """Bounded enumeration metadata for one intake (workspace TDD §5.1).

    Deliberately carries no sanitized text, OCR, layout boxes, token maps, page bytes or
    hashes of originals, so the row may cross the same-origin proxy while `/review` and
    `/preview` stay direct-pairing-only. Returns None for records that are not v2 intakes.
    """
    if record.get("version") != 2 or not record.get("intakeId"):
        return None
    classification = record.get("classification") or {}
    quality = record.get("quality") or {}
    risk = record.get("reviewRisk") or {}
    retention = record.get("retentionUntil")
    # Expiry is a timestamp, not content, and the workspace needs it: an approved intake is
    # waiting on a human, and expiry bumps the revision back to REVIEW_READY.
    approval = ((record.get("envelope") or {}).get("manifest") or {}).get("approval") or {}
    return {
        "intakeId": record["intakeId"],
        "documentId": record["documentId"],
        "revision": record["revision"],
        "stage": record["stage"],
        "caseId": record.get("caseId"),
        "pageCount": page_count(record),
        "quality": {"status": quality.get("status"), "reasons": list(quality.get("reasons", []))} if quality else None,
        "classification": {
            "status": classification.get("status"),
            "documentType": classification.get("documentType"),
            "confidence": classification.get("confidence"),
            "calibration": classification.get("calibration"),
            "modelId": classification.get("modelId"),
        }
        if classification
        else None,
        "matchHints": record.get("matchHints"),
        "reviewRisk": {
            "reasons": list(risk.get("reasons", [])),
            "policyVersion": risk.get("policyVersion"),
            "provisional": bool(risk.get("provisional", True)),
        },
        "approvalExpiresAt": approval.get("expiresAt"),
        "releaseError": record.get("releaseError"),
        "updatedAt": record.get("updatedAt", record.get("createdAt")),
        "retentionUntil": stamp(datetime.fromtimestamp(retention, timezone.utc)) if isinstance(retention, (int, float)) else None,
        "originalDeleted": bool(record.get("originalDeleted")),
    }


class Start(Strict):
    caseId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    destinations: list[Destination] = Field(default_factory=lambda: ["lloyd-api"], min_length=1, max_length=5)


class Page(Strict):
    source: str = Field(default="camera", pattern="^(camera|upload)$")
    contentBase64: str | None = Field(default=None, max_length=14_000_000)
    mediaType: str = Field(default="image/png", pattern="^(text/plain|image/png|image/jpeg)$")


class CaseSelection(Strict):
    revision: int = Field(ge=1)
    caseId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")


class Approve(Strict):
    revision: int = Field(ge=1)
    acknowledgedQuality: bool = False


class AddRedactions(Strict):
    revision: int = Field(ge=1)
    blockIds: list[str] = Field(min_length=1, max_length=MAX_BLOCKS)


def install_v2(app, settings, store, ocr, release_client, classifier=None, detector=None):
    classifier = classifier or LocalClassifier(settings.classifier_path, settings.classifier_digest)
    detector = detector or SemanticDetector(settings.detector_path, settings.detector_digest)
    lock = threading.RLock()
    app.state.classifier = classifier
    app.state.detector = detector

    def load(intake_id) -> dict:
        try:
            record = store.load(str(intake_id))
        except FileNotFoundError:
            raise HTTPException(404, "Intake not found") from None
        if record.get("version") != 2:
            raise HTTPException(404, "Intake not found")
        return record

    def save(record: dict) -> None:
        """Record and index row are written together inside the caller's lock, so a crash can
        never leave a list row describing a stage the record did not reach."""
        record["updatedAt"] = stamp()
        store.save(record["intakeId"], record, index_row=intake_summary(record))

    def transition(record: dict, stage: str) -> None:
        record["stage"] = stage
        record.setdefault("stageHistory", []).append({"stage": stage, "at": stamp(), "revision": record["revision"]})
        record["stageHistory"] = record["stageHistory"][-200:]

    def mutable(record: dict) -> None:
        if record.get("originalDeleted"):
            raise HTTPException(410, "Original expired")
        if record["stage"] in {"RELEASE_PENDING", "ACCEPTED"}:
            raise HTTPException(409, "Released revision is immutable; start a new intake")

    def invalidate(record: dict) -> None:
        """Any change to inputs or derivatives creates a new revision and discards approval."""
        record["revision"] += 1
        for key in ("envelope", "classification", "artifacts", "descriptors", "fields", "quality", "matchHints", "reviewRisk", "tokenMap", "rawDetections"):
            record.pop(key, None)

    def status(record: dict) -> dict:
        return {
            "intakeId": record["intakeId"],
            "documentId": record["documentId"],
            "revision": record["revision"],
            "stage": record["stage"],
            "caseId": record.get("caseId"),
            "pageCount": page_count(record),
            "quality": record.get("quality"),
            "classification": record.get("classification"),
            "matchHints": record.get("matchHints"),
            "reviewRisk": record.get("reviewRisk"),
            "approval": (record.get("envelope") or {}).get("manifest", {}).get("approval"),
            "receipt": record.get("receipt"),
            "releaseError": record.get("releaseError"),
            "limitations": LIMITATIONS,
            "model": {"classifier": classifier.capabilities(), "detector": detector.capabilities()},
        }

    def reviewer_for(token: str) -> dict | None:
        if not token:
            return None
        for reviewer in settings.reviewers:
            if hmac.compare_digest(reviewer["token"], token):
                return reviewer
        return None

    def build_manifest(record: dict, approval: dict | None) -> dict:
        return {
            "version": 2,
            "intakeId": record["intakeId"],
            "documentId": record["documentId"],
            "revision": record["revision"],
            "deviceId": settings.device_id,
            "tenantId": settings.tenant_id,
            "caseId": record.get("caseId"),
            "policyVersion": PRIVACY_POLICY_VERSION,
            "createdAt": record["createdAt"],
            "classification": record["classification"],
            "matchHints": record["matchHints"],
            "quality": record["quality"],
            "fields": record["fields"],
            "artifacts": record["descriptors"],
            "destinations": record["destinations"],
            "approval": approval or {"reviewerId": "unapproved", "approvedAt": record["createdAt"], "expiresAt": record["createdAt"], "acknowledgedQuality": False},
        }

    @app.post("/v2/intakes")
    def start(body: Start):
        if not settings.local_token:
            raise HTTPException(503, "Local pairing must be configured")
        if not set(body.destinations) <= settings.allowed or "lloyd-api" not in body.destinations or len(set(body.destinations)) != len(body.destinations):
            raise HTTPException(403, "Destination denied")
        record = {
            "version": 2,
            "intakeId": str(uuid4()),
            "documentId": str(uuid4()),
            "revision": 1,
            "caseId": body.caseId,
            "destinations": body.destinations,
            "pages": [],
            "stage": "CAPTURED",
            "stageHistory": [],
            "pageCount": 0,
            "createdAt": stamp(),
            "retentionUntil": time.time() + settings.retention,
        }
        transition(record, "CAPTURED")
        save(record)
        return status(record)

    @app.get("/v2/intakes")
    def list_intakes(stage: str | None = None, limit: int = 50):
        """Bounded metadata for every local intake, so the operator workspace can enumerate
        device-side work and a reloaded browser can find its in-flight intake again.

        Requires the local pairing token like every other v2 route. It carries no document
        content, which is why it — unlike `/review` and `/preview` — may cross the
        same-origin proxy (workspace TDD §5.1).
        """
        if stage is not None and stage not in STAGES:
            raise HTTPException(422, "Unknown stage")
        if not 1 <= limit <= 100:
            raise HTTPException(422, "limit must be between 1 and 100")
        with lock:
            rows = store.index_all(intake_summary)
        rows = [r for r in rows if stage is None or r["stage"] == stage]
        rows.sort(key=lambda r: (r.get("updatedAt") or "", r["intakeId"]), reverse=True)
        return {"items": rows[:limit], "total": len(rows)}

    @app.post("/v2/intakes/{intake_id}/pages")
    def add_page(intake_id: UUID, body: Page):
        with lock:
            record = load(intake_id)
            mutable(record)
            if len(record["pages"]) >= MAX_PAGES:
                raise HTTPException(400, "Page limit exceeded")
            if body.source == "camera":
                try:
                    raw, media = app.state.camera.capture()
                except (ImportError, RuntimeError):
                    raise HTTPException(503, "Camera unavailable") from None
            else:
                try:
                    raw, media = base64.b64decode(body.contentBase64 or "", validate=True), body.mediaType
                except ValueError:
                    raise HTTPException(400, "Invalid encoding") from None
            if not raw or len(raw) > MAX_IMAGE_BYTES:
                raise HTTPException(400, "Invalid page size")
            if media.startswith("image/"):
                try:
                    corrected, quality = preprocess(raw, settings.quality_policy, app.state.page_detector)
                except (ValueError, OSError):
                    raise HTTPException(400, "Unreadable image") from None
            else:
                corrected, quality = raw, {"status": "PASS", "reasons": [], "adapter": "text", "policyVersion": settings.quality_policy.version}
            invalidate(record)
            record["pages"].append(
                {
                    "id": str(uuid4()),
                    "number": len(record["pages"]) + 1,
                    "original": base64.b64encode(raw).decode(),
                    "originalSha256": hashlib.sha256(raw).hexdigest(),
                    "corrected": base64.b64encode(corrected).decode(),
                    "mediaType": media,
                    "adapter": body.source,
                    "capturedAt": stamp(),
                    "quality": quality,
                }
            )
            record["pageCount"] = len(record["pages"])
            transition(record, "PREPROCESSED")
            save(record)
            return {**status(record), "pageQuality": {"status": quality["status"], "reasons": quality["reasons"]}}

    @app.post("/v2/intakes/{intake_id}/case")
    def select_case(intake_id: UUID, body: CaseSelection):
        with lock:
            record = load(intake_id)
            mutable(record)
            if record["revision"] != body.revision:
                raise HTTPException(409, "Revision changed")
            if record.get("caseId") != body.caseId:
                record["caseId"] = body.caseId
                # Case selection is bound by approval; changing it requires re-review of a new revision.
                record.pop("envelope", None)
                record["revision"] += 1
                if record["stage"] in {"APPROVED", "RELEASE_FAILED"}:
                    transition(record, "REVIEW_READY")
                save(record)
            return status(record)

    @app.post("/v2/intakes/{intake_id}/analyze")
    def analyze(intake_id: UUID):
        with lock:
            record = load(intake_id)
            mutable(record)
            if not record["pages"]:
                raise HTTPException(409, "Capture a page first")
            invalidate(record)
            page_count = len(record["pages"])
            assessments: list[PageAssessment] = []
            blocks: list[dict] = []
            for page in record["pages"]:
                result = ocr.extract(base64.b64decode(page["corrected"]), page["mediaType"])
                page["ocr"] = asdict(result)
                assessments.append(PageAssessment(page["quality"]["status"], list(page["quality"].get("reasons", [])), page["quality"].get("metrics", {})))
                assessments.append(assess_ocr(result.text, result.lines, result.confidence, settings.quality_policy))
                for line in result.lines:
                    blocks.append({**line, "page": page["number"], "id": f'p{page["number"]}_{line["id"]}'})
            record["quality"] = summarize(assessments, page_count, settings.quality_policy)
            transition(record, "OCR_COMPLETE")
            if record["quality"]["status"] == "RECAPTURE":
                transition(record, "RECAPTURE_REQUIRED")
                save(record)
                return status(record)
            if len(blocks) > MAX_BLOCKS:
                transition(record, "BLOCKED")
                save(record)
                raise HTTPException(400, "Layout limit exceeded")
            block_ids = [b["id"] for b in blocks]
            text = "\n".join(b["text"] for b in blocks)

            try:
                classification = classifier.classify(text, block_ids, blocks, page_count)
            except Exception:
                classification = unavailable_classification(block_ids, page_count)
            record["classification"] = sanitize_classification(classification, block_ids, page_count)
            transition(record, "ANALYZED")
            if record["classification"]["status"] == "UNAVAILABLE" or not detector.ready:
                transition(record, "LOCAL_MODEL_UNAVAILABLE")
                save(record)
                return status(record)
            try:
                semantic = detector.detect(text)
            except Exception:
                transition(record, "BLOCKED")
                save(record)
                return status(record)

            artifacts, descriptors, fields, token_map = [], [], [], {}
            semantic_only_total = 0
            offset = 0
            scope = record.get("caseId") or record["intakeId"]
            for block in blocks:
                length = len(block["text"])
                # Project document-level semantic spans into this block; neighbouring safe blocks are untouched.
                projected = [
                    Span(max(0, s.start - offset), min(length, s.end - offset), "semantic_entity", "redacted", "local-semantic-v1")
                    for s in semantic
                    if s.start < offset + length and s.end > offset
                ]
                projected = [s for s in projected if s.start < s.end]

                class Projected:
                    def __init__(self, spans):
                        self.spans = spans

                    def detect(self, _text):
                        return self.spans

                safe, tokens, detected = redact(block["text"], scope, store.key, extra=[Projected(projected)], patterns=settings.extra_patterns)
                # Identifiers the model found and the patterns missed are what a reviewer must read.
                semantic_only_total += len(semantic_only(block["text"], projected, settings.extra_patterns))
                offset += length + 1
                token_map.update(tokens)
                for f in detected:
                    fields.append({**f, "path": f'field_{len(fields)}.{f["path"].split(".", 1)[1]}'})
                if not safe.strip():
                    safe = "[REDACTED]"
                encoded = safe.encode()
                artifacts.append({"id": block["id"], "mediaType": "text/plain", "text": safe})
                descriptors.append(
                    {
                        "id": block["id"],
                        "mediaType": "text/plain",
                        "byteLength": len(encoded),
                        "sha256": hashlib.sha256(encoded).hexdigest(),
                        "page": block["page"],
                        "blockId": block["id"],
                        "box": [int(v) for v in block["box"]] if block.get("box") else None,
                    }
                )
            record["rawDetections"] = [asdict(s) for s in semantic]
            record.update(artifacts=artifacts, descriptors=descriptors, fields=fields[:MAX_BLOCKS], tokenMap=token_map)
            record["matchHints"] = build_hints([a["text"] for a in artifacts], record["classification"])
            record["reviewRisk"] = assess_review_risk(
                classification=record["classification"],
                quality=record["quality"],
                hints=record["matchHints"],
                artifacts=artifacts,
                semantic_only_count=semantic_only_total,
                policy=settings.review_risk_policy,
            )
            transition(record, "SANITIZED")
            transition(record, "REVIEW_READY")
            save(record)
            return status(record)

    @app.get("/v2/intakes/{intake_id}/status")
    def get_status(intake_id: UUID):
        with lock:
            return status(load(intake_id))

    @app.get("/v2/intakes/{intake_id}/review")
    def review(intake_id: UUID):
        with lock:
            r = load(intake_id)
            manifest = (r.get("envelope") or {}).get("manifest")
            if manifest is None and r.get("descriptors"):
                manifest = build_manifest(r, None)
            return {
                **status(r),
                "destinations": r["destinations"],
                "artifacts": r.get("artifacts", []),
                "fields": r.get("fields", []),
                "stageHistory": r.get("stageHistory", []),
                "pages": [
                    {"number": p["number"], "mediaType": p["mediaType"], "adapter": p["adapter"], "quality": {"status": p["quality"]["status"], "reasons": p["quality"].get("reasons", [])}, "originalSha256": p["originalSha256"]}
                    for p in r.get("pages", [])
                ],
                "proposedManifest": manifest,
                "approved": bool(r.get("envelope")),
                "v2Enabled": settings.v2_enabled,
            }

    @app.post("/v2/intakes/{intake_id}/redactions")
    def redactions(intake_id: UUID, body: AddRedactions):
        with lock:
            r = load(intake_id)
            mutable(r)
            if r["revision"] != body.revision or not r.get("artifacts"):
                raise HTTPException(409, "Revision unavailable")
            if not set(body.blockIds) <= {a["id"] for a in r["artifacts"]}:
                raise HTTPException(400, "Unknown block")
            r.pop("envelope", None)
            r["revision"] += 1
            redacted = hashlib.sha256(b"[REDACTED]").hexdigest()
            for artifact, desc in zip(r["artifacts"], r["descriptors"]):
                if artifact["id"] in body.blockIds and artifact["text"] != "[REDACTED]":
                    artifact["text"] = "[REDACTED]"
                    desc.update(byteLength=10, sha256=redacted)
                    r["fields"].append({"path": f'field_{len(r["fields"])}.operator', "classification": "redacted", "method": "operator-v2", "confidence": 1.0})
            r["fields"] = r["fields"][:MAX_BLOCKS]
            r["matchHints"] = build_hints([a["text"] for a in r["artifacts"]], r["classification"])
            # Operator redactions change both the hint set and the redacted share.
            r["reviewRisk"] = assess_review_risk(
                classification=r["classification"],
                quality=r["quality"],
                hints=r["matchHints"],
                artifacts=r["artifacts"],
                semantic_only_count=int((r.get("reviewRisk") or {}).get("semanticOnlyDetections", 0)),
                policy=settings.review_risk_policy,
            )
            transition(r, "REVIEW_READY")
            save(r)
            return status(r)

    @app.post("/v2/intakes/{intake_id}/approve")
    def approve(intake_id: UUID, body: Approve, x_human_approval: str = Header(default="")):
        with lock:
            r = load(intake_id)
            reviewer = reviewer_for(x_human_approval)
            if reviewer is None:
                raise HTTPException(403, "Authenticated reviewer required")
            if r["stage"] != "REVIEW_READY" or r["revision"] != body.revision:
                raise HTTPException(409, "Review the exact current revision")
            if r["quality"]["status"] == "REVIEW" and not body.acknowledgedQuality:
                raise HTTPException(409, "Acknowledge quality warnings")
            if not settings.v2_enabled:
                raise HTTPException(503, "V2 release is not enabled for this device; acceptance gates are pending")
            if len(settings.signing_key) < 32 or len(reviewer["key"]) < 32 or settings.signing_key == reviewer["key"]:
                raise HTTPException(503, "Separate paired device and reviewer signing keys required")
            if not settings.device_id or not settings.tenant_id or not settings.signing_key_id:
                raise HTTPException(503, "Device identity not configured")
            now = datetime.now(timezone.utc)
            manifest = build_manifest(
                r,
                {
                    "reviewerId": reviewer["id"],
                    "approvedAt": stamp(now),
                    "expiresAt": stamp(now + timedelta(seconds=settings.approval_ttl)),
                    "acknowledgedQuality": bool(body.acknowledgedQuality),
                },
            )
            envelope = {
                "manifest": manifest,
                "artifacts": r["artifacts"],
                "authentication": {
                    "keyId": settings.signing_key_id,
                    "algorithm": "HMAC-SHA256",
                    "signature": signature(manifest, settings.signing_key),
                    "reviewerSignature": signature(manifest, reviewer["key"], "reviewer"),
                },
            }
            try:
                validate_envelope(envelope)
            except (jsonschema.ValidationError, ValueError) as exc:
                raise HTTPException(409, f"Derivative failed release schema: {type(exc).__name__}") from None
            r["envelope"] = envelope
            r.pop("releaseError", None)
            transition(r, "APPROVED")
            save(r)
            return status(r)

    @app.post("/v2/intakes/{intake_id}/release")
    def release(intake_id: UUID):
        with lock:
            r = load(intake_id)
            if r["stage"] == "ACCEPTED":
                return status(r)
            envelope = r.get("envelope")
            if not envelope or r["stage"] not in {"APPROVED", "RELEASE_PENDING", "RELEASE_FAILED"}:
                raise HTTPException(409, "Approve the exact revision first")
            if not settings.v2_enabled:
                raise HTTPException(503, "V2 release is not enabled for this device")
            # Revalidate policy and integrity immediately before transmission.
            try:
                validate_envelope(envelope)
            except (jsonschema.ValidationError, ValueError):
                raise HTTPException(403, "Release policy or integrity changed") from None
            m = envelope["manifest"]
            if m["revision"] != r["revision"] or not set(m["destinations"]) <= settings.allowed:
                raise HTTPException(403, "Release policy or integrity changed")
            if not hmac.compare_digest(envelope["authentication"]["signature"], signature(m, settings.signing_key)):
                raise HTTPException(403, "Release policy or integrity changed")
            now = datetime.now(timezone.utc)
            if parse_stamp(m["approval"]["expiresAt"]) <= now:
                r.pop("envelope", None)
                r["revision"] += 1
                transition(r, "REVIEW_READY")
                save(r)
                raise HTTPException(409, "Approval expired; review the new revision")
            server_now = release_client.server_time()
            if server_now is not None and abs((server_now - now).total_seconds()) > settings.clock_tolerance:
                raise HTTPException(409, f"Device clock differs from backend by more than {settings.clock_tolerance}s; correct UTC before releasing")
            transition(r, "RELEASE_PENDING")
            r["releaseAttempts"] = r.get("releaseAttempts", 0) + 1
            save(r)
            try:
                receipt = release_client.send_v2(envelope)
            except ReleaseConflict as exc:
                r["releaseError"] = str(exc)[:40]
                transition(r, "RELEASE_FAILED")
                save(r)
                raise HTTPException(409, "Backend holds a different digest for this revision") from None
            except Exception:
                r["releaseError"] = "TRANSPORT"
                transition(r, "RELEASE_FAILED")
                save(r)
                raise HTTPException(502, "Release failed; retry the same approved revision") from None
            r["receipt"] = {k: receipt.get(k) for k in ("intakeId", "revision", "digest", "status", "association", "receivedAt")}
            r.pop("releaseError", None)
            transition(r, "ACCEPTED")
            save(r)
            return status(r)

    @app.delete("/v2/intakes/{intake_id}/originals")
    def delete_originals(intake_id: UUID):
        with lock:
            r = load(intake_id)
            r = store.delete_original(str(intake_id), r)
            transition(r, "ORIGINAL_EXPIRED")
            save(r)
            return status(r)
