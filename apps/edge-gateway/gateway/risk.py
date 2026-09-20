"""Deterministic review-risk flag for the `Needs Privacy Review` queue.

Approval stays mandatory for every release (TDD v2 §5.5); this flag only orders the
reviewer's queue and says where to look. No model can set or clear it, and an empty reason
list never removes an approval requirement.

Thresholds are provisional until calibrated on the held-out capture corpus, which the
policy states explicitly so the UI can label the flag rather than imply it is tuned.
"""
from __future__ import annotations

from dataclasses import dataclass

from .privacy import Span, detect

REASONS = (
    "CLASSIFIER_ABSTAINED",
    "LOW_CLASSIFIER_CONFIDENCE",
    "SEMANTIC_ONLY_DETECTIONS",
    "QUALITY_REVIEW",
    "HEAVY_REDACTION",
    "INSUFFICIENT_HINTS",
)
# Hints that can actually rank a case (mirrors rankCandidates in packages/integrations).
RANKING_HINTS = ("riskState", "yearRange", "tivBucket", "lineOfBusiness")


@dataclass(frozen=True)
class ReviewRiskPolicy:
    version: str = "review-risk-v1-provisional"
    # Set only once the held-out corpus calibrates these numbers; until then the UI labels
    # every reason provisional (TDD §11).
    calibrated: bool = False
    low_confidence: float = 0.75
    heavy_redaction_share: float = 0.5

    def as_dict(self) -> dict:
        return {
            "version": self.version,
            "calibrated": self.calibrated,
            "lowConfidence": self.low_confidence,
            "heavyRedactionShare": self.heavy_redaction_share,
        }


DEFAULT_POLICY = ReviewRiskPolicy()


def semantic_only(text: str, semantic: list[Span], patterns: list[str] | None = None) -> list[Span]:
    """Semantic spans the deterministic patterns did not also cover.

    These are the identifiers a model found and the rules missed, which is exactly the case
    a reviewer has to look at by hand.
    """
    deterministic = [s for s in detect(text, patterns=patterns) if s.method == "deterministic-pattern-v1"]
    return [s for s in semantic if not any(d.start < s.end and d.end > s.start for d in deterministic)]


def assess(
    *,
    classification: dict,
    quality: dict,
    hints: dict,
    artifacts: list[dict],
    semantic_only_count: int,
    policy: ReviewRiskPolicy = DEFAULT_POLICY,
) -> dict:
    """Bounded reason codes computed from the device's own sanitized derivative."""
    reasons: list[str] = []
    if classification.get("status") == "ABSTAINED":
        reasons.append("CLASSIFIER_ABSTAINED")
    elif classification.get("status") == "CLASSIFIED" and float(classification.get("confidence", 0)) < policy.low_confidence:
        reasons.append("LOW_CLASSIFIER_CONFIDENCE")
    if semantic_only_count > 0:
        reasons.append("SEMANTIC_ONLY_DETECTIONS")
    if quality.get("status") == "REVIEW":
        reasons.append("QUALITY_REVIEW")
    redacted = sum(1 for a in artifacts if a["text"].strip() == "[REDACTED]")
    share = redacted / len(artifacts) if artifacts else 0.0
    if artifacts and share > policy.heavy_redaction_share:
        reasons.append("HEAVY_REDACTION")
    if not any(hint in hints for hint in RANKING_HINTS):
        reasons.append("INSUFFICIENT_HINTS")
    return {
        "reasons": sorted(r for r in reasons if r in REASONS),
        "policyVersion": policy.version,
        "provisional": not policy.calibrated,
        "redactedBlockShare": round(share, 4),
        "semanticOnlyDetections": semantic_only_count,
    }
