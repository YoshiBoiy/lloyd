"""Versioned page-quality policy (TDD v2 §5.1).

Returns PASS / REVIEW / RECAPTURE plus bounded reason codes. Thresholds live
here, are labelled provisional until calibrated on photographed pages, and
white paper is never treated as glare solely because it is bright.
"""
from __future__ import annotations

from dataclasses import dataclass, field

REASONS = (
    "BLUR",
    "CLIPPED_PAGE",
    "GLARE_OCCLUSION",
    "EMPTY_OCR",
    "LOW_TEXT_CONFIDENCE",
    "PERSPECTIVE_UNCERTAIN",
    "UNCALIBRATED_POLICY",
)


@dataclass(frozen=True)
class QualityPolicy:
    version: str = "quality-v2-provisional"
    # Set only after the held-out capture corpus calibrates these numbers.
    calibrated: bool = False
    blur_review: float = 60.0
    blur_recapture: float = 12.0
    # Glare = a saturated blob materially brighter than the page's own paper level
    # that covers a meaningful part of the page. A uniformly bright page has no such
    # contrast and is not glare.
    glare_saturation: int = 252
    glare_min_blob_fraction: float = 0.004
    glare_ring_contrast: float = 25.0
    glare_review_fraction: float = 0.01
    glare_recapture_fraction: float = 0.08
    # Page quad corners closer than this to the frame edge mean text may be cut off.
    clip_margin_px: int = 3
    min_text_confidence: float = 0.60
    max_pages: int = 20

    def as_dict(self) -> dict:
        return {
            "version": self.version,
            "calibrated": self.calibrated,
            "blurReview": self.blur_review,
            "blurRecapture": self.blur_recapture,
            "glareReviewFraction": self.glare_review_fraction,
            "glareRecaptureFraction": self.glare_recapture_fraction,
            "minTextConfidence": self.min_text_confidence,
        }


DEFAULT_POLICY = QualityPolicy()


@dataclass
class PageAssessment:
    status: str
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


def _worst(a: str, b: str) -> str:
    order = {"PASS": 0, "REVIEW": 1, "RECAPTURE": 2}
    return a if order[a] >= order[b] else b


def glare_fraction(gray, policy: QualityPolicy = DEFAULT_POLICY) -> float:
    """Fraction of the page covered by bright blobs that stand out from their surroundings.

    `gray` is a 2-D uint8 array of the corrected page. Requires OpenCV.
    """
    import cv2
    import numpy as np

    saturated = gray >= policy.glare_saturation
    if not saturated.any():
        return 0.0
    # The page's own paper level, measured away from saturated pixels. A page that is
    # almost entirely saturated is overexposed paper, not an occluding highlight.
    unsaturated = gray[~saturated]
    if unsaturated.size < 0.1 * gray.size:
        return 0.0
    background = float(np.median(unsaturated))
    # Remove thin gaps between glyphs; glare blobs survive an opening.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    opened = cv2.morphologyEx(saturated.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    total = float(gray.size)
    covered = 0.0
    for i in range(1, count):
        area = float(stats[i, cv2.CC_STAT_AREA])
        if area / total < policy.glare_min_blob_fraction:
            continue
        core_mean = float(gray[labels == i].mean())
        if core_mean - background >= policy.glare_ring_contrast:
            covered += area
    return covered / total


def assess_page(
    gray,
    *,
    quad,
    frame_shape: tuple[int, int],
    policy: QualityPolicy = DEFAULT_POLICY,
) -> PageAssessment:
    """Assess a corrected page. `gray` is the corrected grayscale page; `quad` the detected
    page corners in original-frame coordinates (or None)."""
    import cv2

    status = "PASS"
    reasons: list[str] = []
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    if blur < policy.blur_recapture:
        status, reasons = _worst(status, "RECAPTURE"), reasons + ["BLUR"]
    elif blur < policy.blur_review:
        status, reasons = _worst(status, "REVIEW"), reasons + ["BLUR"]

    glare = glare_fraction(gray, policy)
    if glare >= policy.glare_recapture_fraction:
        status, reasons = _worst(status, "RECAPTURE"), reasons + ["GLARE_OCCLUSION"]
    elif glare >= policy.glare_review_fraction:
        status, reasons = _worst(status, "REVIEW"), reasons + ["GLARE_OCCLUSION"]

    clipped = False
    if quad is None:
        status, reasons = _worst(status, "REVIEW"), reasons + ["PERSPECTIVE_UNCERTAIN"]
    else:
        height, width = frame_shape
        m = policy.clip_margin_px
        clipped = any(x <= m or y <= m or x >= width - 1 - m or y >= height - 1 - m for x, y in quad)
        if clipped:
            status, reasons = _worst(status, "REVIEW"), reasons + ["CLIPPED_PAGE"]

    if not policy.calibrated:
        status, reasons = _worst(status, "REVIEW"), reasons + ["UNCALIBRATED_POLICY"]

    return PageAssessment(
        status,
        sorted(set(reasons)),
        {"blurVariance": round(blur, 3), "glareFraction": round(glare, 5), "clipped": clipped, "pageDetected": quad is not None},
    )


def assess_ocr(text: str, lines: list[dict], confidence: float, policy: QualityPolicy = DEFAULT_POLICY) -> PageAssessment:
    if not text.strip() or not lines:
        return PageAssessment("RECAPTURE", ["EMPTY_OCR"], {"lineCount": 0})
    if confidence < policy.min_text_confidence:
        return PageAssessment("REVIEW", ["LOW_TEXT_CONFIDENCE"], {"lineCount": len(lines), "confidence": confidence})
    return PageAssessment("PASS", [], {"lineCount": len(lines), "confidence": confidence})


def summarize(assessments: list[PageAssessment], page_count: int, policy: QualityPolicy = DEFAULT_POLICY) -> dict:
    """Fold per-page assessments into the bounded SafeQualitySummary released in the manifest."""
    status = "PASS"
    reasons: set[str] = set()
    for a in assessments:
        status = _worst(status, a.status)
        reasons.update(a.reasons)
    if not policy.calibrated:
        status = _worst(status, "REVIEW")
        reasons.add("UNCALIBRATED_POLICY")
    return {
        "status": status,
        "reasons": sorted(r for r in reasons if r in REASONS)[:7],
        "policyVersion": policy.version,
        "pageCount": max(1, min(page_count, policy.max_pages)),
    }
