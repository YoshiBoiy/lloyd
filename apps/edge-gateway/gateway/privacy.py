import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    kind: str
    classification: str = "redacted"


class Detector(Protocol):
    def detect(self, text: str) -> list[Span]: ...


# Extension detectors may ADD spans only. No API accepts an unredaction operation.
PATTERNS = [
    ("email", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "redacted"),
    ("phone", r"(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)", "redacted"),
    ("government_id", r"\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{3}[- ]\d{3}[- ]\d{3}\b", "redacted"),
    ("payment", r"\b(?:\d[ -]?){13,19}\b", "redacted"),
    ("credential", r"\b(?:sk-|api[_ -]?key\s*[:=]\s*|secret\s*[:=]\s*)[A-Za-z0-9_\-+/=]{8,}", "redacted"),
    (
        "policy_identifier",
        r"(?im)\b(?:policy|claim|employee)[ _-]*(?:number|id|no\.?)?\s*[:#=]\s*([^\n]+)",
        "tokenized",
    ),
    ("person_name", r"(?im)\b(?:name|contact|insured person)\s*:\s*([^\n]+)", "tokenized"),
    ("signature", r"(?im)\bsignature\s*:\s*([^\n]+)", "redacted"),
    ("address", r"(?im)\b(?:(?:home|property|street|commercial)\s+)?address\s*:\s*([^\n]+)", "redacted"),
    ("birth_date", r"(?im)\b(?:date of birth|dob)\s*:\s*([^\n]+)", "generalized"),
    ("medical", r"(?im)\b(?:medical|diagnosis|access code|password)\s*:\s*([^\n]+)", "redacted"),
]


def detect(text: str, extra: list[Detector] | None = None, patterns: list[str] | None = None) -> list[Span]:
    spans = []
    for kind, pattern, classification in PATTERNS:
        for match in re.finditer(pattern, text):
            start, end = match.span(1 if match.lastindex else 0)
            spans.append(Span(start, end, kind, classification))
    for pattern in patterns or []:
        spans.extend(Span(m.start(), m.end(), "configured") for m in re.finditer(pattern, text))
    for detector in extra or []:
        spans.extend(detector.detect(text))
    if any(s.start < 0 or s.end > len(text) or s.start >= s.end for s in spans):
        raise ValueError("Invalid sensitive span")
    return sorted(spans, key=lambda s: (s.start, -s.end))


def redact(text: str, case_id: str, key: bytes, extra: list[Detector] | None = None, patterns: list[str] | None = None):
    spans = detect(text, extra, patterns)
    # Union overlaps before replacement: a partial token must never leave a sensitive suffix behind.
    merged: list[Span] = []
    for span in spans:
        if merged and span.start < merged[-1].end:
            old = merged.pop()
            merged.append(Span(old.start, max(old.end, span.end), "sensitive_overlap"))
        else:
            merged.append(span)
    token_map = {}
    fields = []
    pieces = []
    position = 0
    for i, span in enumerate(merged):
        value = text[span.start : span.end]
        replacement = "[REDACTED]"
        if span.classification == "tokenized":
            token = hmac.new(key, (case_id + "\0" + value).encode(), hashlib.sha256).hexdigest()[:24]
            replacement = "[TOKEN_" + token + "]"
            token_map[replacement] = value
        elif span.classification == "generalized":
            replacement = "[AGE_BAND_WITHHELD]"
        pieces.extend([text[position : span.start], replacement])
        fields.append(
            {
                "path": f"field_{i}.{span.kind}",
                "classification": span.classification,
                "method": "deterministic-pattern-v1",
                "confidence": 0.99,
            }
        )
        position = span.end
    pieces.append(text[position:])
    return "".join(pieces), token_map, fields
