"""Offline local inference (TDD v2 §5.2-5.3).

`LocalClassifier` runs a trained multinomial text classifier provisioned as a
digest-verified artifact. `SemanticDetector` wraps a locally provisioned spaCy
NER pipeline and may only ADD sensitive spans. Neither has tools, network, shell
or release capability; a missing artifact reports UNAVAILABLE and is never
substituted by regex heuristics.
"""
import hashlib
import json
import math
import re
import time
from pathlib import Path
from typing import Protocol

from .privacy import Span

LABELS = {"inspection_report", "loss_run", "statement_of_values", "application", "policy_document", "correspondence", "mixed"}
RUNTIME_VERSION = "multinomial-v1"
MODEL_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,100}")

PROPERTY_TERMS = {"tiv", "building", "construction", "sprinkler", "sprinklered", "roof", "occupancy", "sov", "insured value"}
CASUALTY_TERMS = {"liability", "bodily", "injury", "claimant", "general liability", "auto", "workers", "compensation"}


class DocumentClassifier(Protocol):
    def classify(self, text: str, evidence_ids: list[str], layout: list[dict] | None = None) -> dict: ...

    def capabilities(self) -> dict: ...


def unavailable_classification(evidence_ids: list[str], page_count: int = 1) -> dict:
    return {
        "status": "UNAVAILABLE",
        "documentType": "unknown",
        "confidence": 0,
        "calibration": "UNCALIBRATED",
        "alternatives": [],
        "attributes": {"language": "unknown", "pageCount": max(1, min(page_count, 20)), "hasTables": False, "lineOfBusiness": "unknown"},
        "modelId": "unprovisioned",
        "artifactDigest": None,
        "runtimeVersion": RUNTIME_VERSION,
        "latencyMs": 0,
        "evidenceIds": evidence_ids[:2000],
    }


def derive_attributes(text: str, layout: list[dict] | None, page_count: int) -> dict:
    """Bounded, enum-only attributes derived deterministically from local layout/text."""
    tokens = re.findall(r"[A-Za-z]+", text)
    ascii_ratio = sum(1 for t in tokens if t.isascii()) / len(tokens) if tokens else 0
    lower = text.lower()
    property_hits = sum(1 for term in PROPERTY_TERMS if term in lower)
    casualty_hits = sum(1 for term in CASUALTY_TERMS if term in lower)
    if property_hits and casualty_hits:
        lob = "mixed"
    elif property_hits:
        lob = "property"
    elif casualty_hits:
        lob = "casualty"
    else:
        lob = "unknown"
    # Multi-column lines are the layout signature of a table; three such rows count as one.
    column_rows = sum(1 for block in layout or [] if "_col_" in str(block.get("id", "")))
    return {
        "language": "en" if tokens and ascii_ratio > 0.95 else "unknown",
        "pageCount": max(1, min(page_count, 20)),
        "hasTables": column_rows >= 3,
        "lineOfBusiness": lob,
    }


class LocalClassifier:
    def __init__(self, path: str = "", digest: str = ""):
        self.model = None
        self.digest = None
        self.path = path
        self.error = None
        if path and digest:
            try:
                self.model, self.digest = self._load(Path(path), digest)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                # The failure is recorded for the health endpoint; inference stays UNAVAILABLE.
                self.error = type(exc).__name__

    @staticmethod
    def _load(path: Path, digest: str):
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("Classifier artifact digest mismatch")
        m = json.loads(content)
        if set(m["labels"]) != LABELS or m["format"] != "lloyd-multinomial-v1":
            raise ValueError("Invalid classifier artifact")
        if not MODEL_ID_RE.fullmatch(m["modelId"]):
            raise ValueError("Invalid model identity")
        if not 0 < m["threshold"] <= 1 or not 0 < m["minCoverage"] <= 1:
            raise ValueError("Invalid abstention policy")
        weights = m["weights"]
        if not weights or any(
            len(v) != len(m["labels"]) or any(not math.isfinite(x) for x in v) for v in weights.values()
        ):
            raise ValueError("Invalid trained weights")
        if len(m["priors"]) != len(m["labels"]) or any(not math.isfinite(x) for x in m["priors"]):
            raise ValueError("Invalid trained priors")
        return m, digest

    @property
    def ready(self) -> bool:
        return self.model is not None

    def capabilities(self) -> dict:
        return {
            "ready": self.ready,
            "modelId": self.model["modelId"] if self.model else None,
            "artifactDigest": self.digest,
            "runtimeVersion": RUNTIME_VERSION,
            "calibration": self.model.get("calibration", "UNCALIBRATED") if self.model else None,
            "error": self.error,
        }

    def classify(self, text: str, evidence_ids: list[str], layout: list[dict] | None = None, page_count: int = 1) -> dict:
        start = time.monotonic()
        result = unavailable_classification(evidence_ids, page_count)
        if not self.model:
            return result
        m = self.model
        tokens = re.findall(r"\b\w+\b", text.lower())
        known = [t for t in tokens if t in m["weights"]]
        logits = [prior + sum(m["weights"][t][i] for t in known) for i, prior in enumerate(m["priors"])]
        maximum = max(logits)
        probs = [math.exp(x - maximum) for x in logits]
        total = sum(probs)
        alternatives = sorted(
            [{"label": label, "confidence": round(p / total, 6)} for label, p in zip(m["labels"], probs)],
            key=lambda x: -x["confidence"],
        )[:8]
        best = alternatives[0]
        coverage = len(known) / len(tokens) if tokens else 0
        accepted = bool(tokens) and coverage >= m["minCoverage"] and best["confidence"] >= m["threshold"]
        result.update(
            status="CLASSIFIED" if accepted else "ABSTAINED",
            documentType=best["label"] if accepted else "unknown",
            confidence=best["confidence"],
            calibration=m.get("calibration", "UNCALIBRATED") if m.get("calibration") in {"CALIBRATED", "UNCALIBRATED"} else "UNCALIBRATED",
            alternatives=alternatives,
            attributes=derive_attributes(text, layout, page_count),
            modelId=m["modelId"],
            artifactDigest=self.digest,
            latencyMs=round((time.monotonic() - start) * 1000, 3),
        )
        return result


class SemanticDetector:
    """Locally provisioned spaCy NER adds spans; never grants release permission."""

    LABELS = {"PERSON", "ORG", "GPE", "LOC", "FAC"}

    def __init__(self, path: str = "", digest: str = ""):
        self.nlp = None
        self.digest = None
        self.error = None
        if path and digest:
            try:
                self._load(Path(path), digest)
            except (OSError, ValueError, ImportError) as exc:
                self.error = type(exc).__name__

    def _load(self, root: Path, digest: str):
        files = sorted(p for p in root.rglob("*") if p.is_file())
        actual = hashlib.sha256(
            b"".join(str(p.relative_to(root)).encode() + b"\0" + hashlib.sha256(p.read_bytes()).digest() for p in files)
        ).hexdigest()
        if actual != digest:
            raise ValueError("Semantic model digest mismatch")
        import spacy

        nlp = spacy.load(root, disable=["parser", "lemmatizer"])
        if "ner" not in nlp.pipe_names:
            raise ValueError("Semantic detector requires trained NER")
        self.nlp, self.digest = nlp, actual

    @property
    def ready(self):
        return self.nlp is not None

    def capabilities(self) -> dict:
        return {
            "ready": self.ready,
            "modelId": self.nlp.meta.get("name") if self.nlp else None,
            "artifactDigest": self.digest,
            "runtimeVersion": f"spacy-{self.nlp.meta.get('spacy_version', 'unknown')}" if self.nlp else None,
            "error": self.error,
        }

    def detect(self, text: str) -> list[Span]:
        if self.nlp is None:
            raise ValueError("Semantic detector unavailable")
        return [
            Span(e.start_char, e.end_char, "semantic_entity", "redacted", "local-semantic-v1")
            for e in self.nlp(text).ents
            if e.label_ in self.LABELS
        ]
