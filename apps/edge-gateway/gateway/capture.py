import base64
import io
import os
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from PIL import Image

from .quality import DEFAULT_POLICY, QualityPolicy, assess_page


class Camera(Protocol):
    def capture(self) -> tuple[bytes, str]: ...


class FixtureCamera:
    def __init__(self, path: Path):
        self.path = path

    def capture(self):
        return self.path.read_bytes(), "text/plain" if self.path.suffix == ".txt" else "image/png"


class OpenCVCamera:
    def __init__(self, index: int | None = None, warmup_frames: int | None = None):
        # RDK X5 boards expose the sensor at a fixed V4L2 index (commonly 0);
        # keep it operator-configurable rather than hardcoded so a re-plugged
        # or multi-camera board does not silently grab the wrong device.
        self.index = index if index is not None else int(os.environ.get("EDGE_CAMERA_INDEX", "0"))
        self.warmup_frames = (
            warmup_frames if warmup_frames is not None else int(os.environ.get("EDGE_CAMERA_WARMUP_FRAMES", "2"))
        )

        self._lock = threading.RLock()
        self._camera = None
        self._users = 0
        self._last_available_ok = 0.0

    @contextmanager
    def session(self):
        """Share one device handle across preview, capture and health requests."""
        import cv2

        with self._lock:
            if self._camera is None:
                camera = cv2.VideoCapture(self.index)
                try:
                    if not camera.isOpened():
                        raise RuntimeError("Camera unavailable")
                    for _ in range(max(0, self.warmup_frames)):
                        camera.read()
                except Exception:
                    camera.release()
                    raise
                self._camera = camera
            self._users += 1
        try:
            yield self
        finally:
            with self._lock:
                self._users -= 1
                if self._users == 0:
                    camera, self._camera = self._camera, None
                    camera.release()

    def read_frame(self):
        with self._lock:
            if self._camera is None:
                raise RuntimeError("Camera unavailable")
            ok, frame = self._camera.read()
            if not ok or frame is None:
                raise RuntimeError("Camera unavailable")
            # Own the pixels after releasing the lock; preview overlays must never
            # mutate a frame used for capture.
            return frame.copy()

    def capture(self):
        import cv2

        with self.session():
            frame = self.read_frame()
        ok, encoded = cv2.imencode(".png", frame)
        if not ok:
            raise RuntimeError("Camera encoding failed")
        return encoded.tobytes(), "image/png"

    def available(self) -> bool:
        with self._lock:
            if self._camera is not None:
                self._last_available_ok = time.monotonic()
                return True
            if self._last_available_ok and time.monotonic() - self._last_available_ok < 15:
                return True
        try:
            with self.session():
                with self._lock:
                    self._last_available_ok = time.monotonic()
                return True
        except (ImportError, RuntimeError):
            return False


def camera_available(index: int | None = None) -> bool:
    return OpenCVCamera(index).available()


@dataclass
class OCRResult:
    text: str
    confidence: float
    adapter: str
    lines: list[dict] = field(default_factory=list)
    width: int = 0
    height: int = 0
    orientation: int = 0
    metrics: dict = field(default_factory=dict)


class OCR(Protocol):
    def extract(self, content: bytes, media_type: str) -> OCRResult: ...


def text_layout(text: str) -> list[dict]:
    """Layout blocks for a plain-text page: one block per non-empty line, no pixel boxes."""
    return [
        {"id": f"line_{i}", "text": line, "box": None, "confidence": 1.0, "words": []}
        for i, line in enumerate(text.splitlines())
        if line.strip()
    ]


class LocalOCR:
    def available(self) -> bool:
        try:
            import pytesseract

            pytesseract.get_tesseract_version()
            return True
        except Exception:
            return False

    def capabilities(self):
        ready = self.available()
        return {
            "adapter": "tesseract",
            "ready": ready,
            "backend": "cpu" if ready else "unavailable",
            "fallback": None,
        }

    def extract(self, content: bytes, media_type: str) -> OCRResult:
        if media_type == "text/plain":
            text = content.decode("utf-8")
            return OCRResult(text, 1.0, "fixture-text", text_layout(text))
        try:
            import pytesseract

            image = Image.open(io.BytesIO(content))
            data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, timeout=10)
            lines = layout_from_tesseract(data)
            scores = [w["confidence"] for line in lines for w in line["words"]]
            return OCRResult(
                "\n".join(line["text"] for line in lines),
                sum(scores) / len(scores) if scores else 0,
                "tesseract",
                lines,
                image.width,
                image.height,
            )
        except (ImportError, RuntimeError, OSError):
            return OCRResult("", 0, "unavailable")


class PaddleOCRAdapter:
    """Optional PaddleOCR 3 pipeline, cached for all captures and serialized."""

    def __init__(self, pipeline_factory=None):
        self._pipeline = None
        self._factory = pipeline_factory
        self._lock = threading.Lock()
        self.error = None
        self.detection_dir = os.environ.get("EDGE_PADDLE_DETECTION_MODEL_DIR", "")
        self.recognition_dir = os.environ.get("EDGE_PADDLE_RECOGNITION_MODEL_DIR", "")
        self.batch_size = max(1, min(32, int(os.environ.get("EDGE_OCR_BATCH_SIZE", "8"))))

    def available(self) -> bool:
        from importlib.util import find_spec

        return bool(self.detection_dir and self.recognition_dir
                    and Path(self.detection_dir).is_dir() and Path(self.recognition_dir).is_dir()
                    and (self._factory is not None or find_spec("paddleocr") is not None))

    def capabilities(self):
        return {"adapter": "paddleocr", "ready": self.available(), "persistent": True,
                "loaded": self._pipeline is not None, "batchSize": self.batch_size,
                "coordinateSpace": "corrected-page", "error": self.error, "fallback": "tesseract"}

    def extract(self, content: bytes, media_type: str) -> OCRResult:
        if media_type == "text/plain":
            return LocalOCR().extract(content, media_type)
        if not self.available():
            result = LocalOCR().extract(content, media_type)
            result.metrics.update({"fallbackFrom": "paddleocr", "error": "MODEL_UNAVAILABLE"})
            return result
        try:
            import numpy as np
            from .ocr_runtime import page_box

            os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
            factory = self._factory
            if factory is None:
                from paddleocr import PaddleOCR
                factory = PaddleOCR
            with Image.open(io.BytesIO(content)) as source:
                if source.width * source.height > 20_000_000:
                    raise ValueError("Image too large")
                image = source.convert("RGB")
            with self._lock:
                if self._pipeline is None:
                    self._pipeline = factory(
                        use_doc_orientation_classify=False,
                        use_doc_unwarping=False,
                        use_textline_orientation=False,
                        text_detection_model_dir=self.detection_dir,
                        text_recognition_model_dir=self.recognition_dir,
                        text_recognition_batch_size=self.batch_size,
                    )
                result = list(self._pipeline.predict(np.array(image)[:, :, ::-1].copy()))
            lines = []
            for page in result:
                if not len(page["rec_texts"]) == len(page["rec_scores"]) == len(page["rec_polys"]):
                    raise ValueError("Recognition count mismatch")
                for text, score, poly in zip(page["rec_texts"], page["rec_scores"], page["rec_polys"]):
                    if not str(text).strip():
                        continue
                    if not np.isfinite(float(score)):
                        raise ValueError("Invalid confidence")
                    polygon, box = page_box(poly, image.width, image.height)
                    lines.append({"text": str(text), "box": box, "polygon": polygon.tolist(),
                                  "confidence": max(0.0, min(1.0, float(score))), "words": []})
            lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
            for index, line in enumerate(lines):
                line["id"] = f"line_{index}"
            self.error = None
            return OCRResult("\n".join(line["text"] for line in lines),
                             sum(line["confidence"] for line in lines) / len(lines) if lines else 0,
                             "paddleocr", lines, image.width, image.height,
                             metrics={"coordinateSpace": "corrected-page", "batchSize": self.batch_size})
        except Exception:
            self.error = "INFERENCE_FAILED"
            result = LocalOCR().extract(content, media_type)
            result.metrics.update({"fallbackFrom": "paddleocr", "error": self.error})
            return result


def layout_from_tesseract(data: dict, column_gap_ratio: float = 2.0) -> list[dict]:
    """Preserve OCR line grouping and corrected-page pixel coordinates.

    Words are grouped by Tesseract page/block/paragraph/line identity, then a line is
    split into column segments wherever the horizontal gap between neighbouring words
    exceeds `column_gap_ratio` times the median word height. This keeps a two-column
    row such as `Contact: <name> | Year built: 2016` as two blocks, so a label pattern
    on the left cannot consume the safe field on the right.
    """
    grouped: dict[str, list[dict]] = {}
    for i, text in enumerate(data["text"]):
        if not str(text).strip():
            continue
        key = tuple(int(data[k][i]) for k in ("page_num", "block_num", "par_num", "line_num"))
        line_id = "line_" + "_".join(map(str, key))
        word = {
            "id": f"{line_id}_word_{i}",
            "text": str(text),
            "box": [int(data[k][i]) for k in ("left", "top", "width", "height")],
            "confidence": max(0.0, min(1.0, float(data["conf"][i]) / 100)),
        }
        grouped.setdefault(line_id, []).append(word)
    lines = []
    for line_id, words in grouped.items():
        words.sort(key=lambda w: w["box"][0])
        heights = sorted(w["box"][3] for w in words)
        median_height = heights[len(heights) // 2] or 1
        segments: list[list[dict]] = [[words[0]]]
        for previous, word in zip(words, words[1:]):
            gap = word["box"][0] - (previous["box"][0] + previous["box"][2])
            if gap > column_gap_ratio * median_height:
                segments.append([word])
            else:
                segments[-1].append(word)
        for index, segment in enumerate(segments):
            x, y = min(w["box"][0] for w in segment), min(w["box"][1] for w in segment)
            right = max(w["box"][0] + w["box"][2] for w in segment)
            bottom = max(w["box"][1] + w["box"][3] for w in segment)
            lines.append(
                {
                    "id": line_id if len(segments) == 1 else f"{line_id}_col_{index}",
                    "text": " ".join(w["text"] for w in segment),
                    "box": [x, y, max(1, right - x), max(1, bottom - y)],
                    "words": segment,
                    "confidence": sum(w["confidence"] for w in segment) / len(segment),
                }
            )
    lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
    return lines


def _order_corners(pts):
    import numpy as np

    pts = np.asarray(pts, dtype="float32").reshape(4, 2)
    sums, differences = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array(
        [pts[np.argmin(sums)], pts[np.argmin(differences)], pts[np.argmax(sums)], pts[np.argmax(differences)]],
        dtype="float32",
    )


def _reduce_to_quad(contour):
    """Approximate a contour by exactly four corners, widening epsilon until it fits."""
    import cv2

    hull = cv2.convexHull(contour)
    perimeter = cv2.arcLength(hull, True)
    for factor in (0.02, 0.03, 0.05, 0.08, 0.12, 0.16):
        polygon = cv2.approxPolyDP(hull, factor * perimeter, True)
        if len(polygon) == 4:
            return polygon.reshape(4, 2)
    return None


def _contour_quads(contour):
    """Page-shaped 4-gons from a contour: poly approximation, then min-area rect."""
    import cv2

    quads = []
    poly = _reduce_to_quad(contour)
    if poly is not None:
        quads.append(poly)
    hull = cv2.convexHull(contour)
    if len(hull) >= 4:
        box = cv2.boxPoints(cv2.minAreaRect(hull))
        rect_area = max(cv2.contourArea(box.astype("float32")), 1.0)
        if cv2.contourArea(hull) / rect_area >= 0.82:
            quads.append(box.astype("float32"))
    return quads


def _interior_angle_deg(prev_pt, pt, next_pt):
    import numpy as np

    ba = prev_pt - pt
    bc = next_pt - pt
    denom = (np.linalg.norm(ba) * np.linalg.norm(bc)) + 1e-6
    cosine = float(np.clip(np.dot(ba, bc) / denom, -1.0, 1.0))
    return float(np.degrees(np.arccos(cosine)))


def _score_page_quad(gray, quad, min_area_fraction: float):
    """Rank a 4-gon as a held page. Ceiling/lights score poorly: huge, mixed, not rectangular."""
    import cv2
    import numpy as np

    h, w = gray.shape[:2]
    ordered = _order_corners(quad)
    area = float(cv2.contourArea(ordered.astype("float32")))
    frame_area = float(h * w)
    frac = area / frame_area
    if frac < min_area_fraction or frac > 0.78:
        return None

    tl, tr, br, bl = ordered
    widths = (np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    heights = (np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    width, height = max(widths), max(heights)
    if width < 12 or height < 12:
        return None
    aspect = width / height
    if aspect < 0.35 or aspect > 2.8:
        return None
    min_side = min(min(widths), min(heights))
    max_side = max(max(widths), max(heights))
    if min_side / (max_side + 1e-6) < 0.22:
        return None

    pts = [tl, tr, br, bl]
    angles = [_interior_angle_deg(pts[i - 1], pts[i], pts[(i + 1) % 4]) for i in range(4)]
    if min(angles) < 42 or max(angles) > 138:
        return None

    # A side lying on the image border and spanning most of that border is the
    # frame/ceiling, not a page. Clipped pages may touch one or two borders.
    def _spans_border(p1, p2, axis, limit, span):
        return abs(p1[axis] - limit) <= 3 and abs(p2[axis] - limit) <= 3 and abs(p1[1 - axis] - p2[1 - axis]) > 0.55 * span

    border_hits = (
        _spans_border(tl, tr, 1, 0, w),
        _spans_border(bl, br, 1, h - 1, w),
        _spans_border(tl, bl, 0, 0, h),
        _spans_border(tr, br, 0, w - 1, h),
    )
    # The live frame itself, or a ceiling spanning the top of the image, is not a page.
    # One side clipped against a border is still a held document.
    if sum(border_hits) >= 3 or border_hits[0]:
        return None

    rect = cv2.minAreaRect(ordered)
    rect_area = max(float(rect[1][0] * rect[1][1]), 1.0)
    rectangularity = float(np.clip(area / rect_area, 0.0, 1.0))
    if rectangularity < 0.72:
        return None

    mask = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(mask, np.round(ordered).astype(np.int32), 255)
    inside = gray[mask > 0]
    outside = gray[mask == 0]
    if inside.size < 50 or outside.size < 50:
        return None
    inside_median = float(np.median(inside))
    outside_median = float(np.median(outside))
    contrast = inside_median - outside_median
    # Paper is brighter than the desk/hand/room. Printed banners make std useless.
    if contrast < 12:
        return None
    paper_pixels = float((inside >= max(165.0, inside_median - 40.0)).mean())
    if paper_pixels < 0.58:
        return None

    side_balance = (min(widths) / (max(widths) + 1e-6)) * (min(heights) / (max(heights) + 1e-6))
    size_pref = 1.0 - abs(frac - 0.32) / 0.32
    contrast_norm = float(np.clip(contrast / 80.0, 0.0, 1.2))
    # Held pages sit near the middle of the frame; ceiling lights sit at the top.
    center_y = float(ordered[:, 1].mean())
    center_pref = 1.0 - abs(center_y - 0.55 * h) / h
    return (
        2.4 * rectangularity
        + 2.2 * paper_pixels
        + 1.6 * contrast_norm
        + 1.1 * side_balance
        + 0.8 * max(0.0, size_pref)
        + 0.9 * max(0.0, center_pref)
    )


def _binary_maps(gray):
    """Edge and fill maps. Nested paper contours are kept (RETR_LIST), not just the outer blob."""
    import cv2
    import numpy as np

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    maps = []
    close = np.ones((9, 9), np.uint8)
    dilate = np.ones((3, 3), np.uint8)
    for low, high in ((40, 120), (60, 180), (90, 220)):
        edges = cv2.Canny(clahe, low, high)
        edges = cv2.dilate(edges, dilate, iterations=1)
        maps.append(cv2.morphologyEx(edges, cv2.MORPH_CLOSE, close))
    grad = cv2.morphologyEx(clahe, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    _, grad_mask = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    maps.append(cv2.morphologyEx(grad_mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)))
    blurred = cv2.GaussianBlur(clahe, (5, 5), 0)
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    maps.append(otsu)
    adaptive = cv2.adaptiveThreshold(clahe, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5)
    maps.append(adaptive)
    return maps


def find_page_quad(gray, min_area_fraction: float = 0.08):
    """Locate the document boundary.

    Rank every 4-gon that looks like a page (rectangle, uniform, brighter than the
    surround) instead of returning the largest blob. That keeps a held flyer from
    losing to ceiling lights in a cluttered room.
    """
    import cv2
    import numpy as np

    if gray is None or gray.size == 0:
        return None
    total = float(gray.size)
    min_area = min_area_fraction * total
    best_quad, best_score = None, float("-inf")
    seen = set()
    for binary in _binary_maps(gray):
        contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            if cv2.contourArea(contour) < min_area:
                continue
            for quad in _contour_quads(contour):
                area = cv2.contourArea(quad.astype("float32"))
                if area < min_area:
                    continue
                key = tuple(np.round(quad).astype(int).reshape(-1))
                if key in seen:
                    continue
                seen.add(key)
                score = _score_page_quad(gray, quad, min_area_fraction)
                if score is not None and score > best_score:
                    best_score = score
                    best_quad = _order_corners(quad)
    return best_quad


def fit_page_quad_from_mask(gray, mask):
    """Fit a page inside the segmentation ROI; no full-frame edge extraction."""
    import cv2
    import numpy as np

    if gray is None or gray.size == 0 or mask is None:
        return None
    mask = np.asarray(mask)
    if mask.ndim != 2 or mask.size == 0 or not np.isfinite(mask).all():
        return None
    binary = (mask > 0.5).astype(np.uint8) * 255
    h, w = gray.shape[:2]
    binary = cv2.resize(binary, (w, h), interpolation=cv2.INTER_NEAREST)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    binary.fill(0)
    cv2.drawContours(binary, [contour], -1, 255, -1)
    if not 0.06 <= np.count_nonzero(binary) / float(h * w) <= 0.78:
        return None
    radius = max(1, int(round(0.04 * min(h, w))))
    roi = cv2.dilate(binary, np.ones((2 * radius + 1, 2 * radius + 1), np.uint8))
    x, y, rw, rh = cv2.boundingRect(roi)
    edges = cv2.Canny(gray[y:y + rh, x:x + rw], 40, 120)
    edges[roi[y:y + rh, x:x + rw] == 0] = 0
    edge_contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = _contour_quads(contour)
    for edge in edge_contours:
        if cv2.contourArea(edge) >= 0.06 * h * w:
            candidates.extend(_contour_quads(edge + np.array([[[x, y]]], dtype=edge.dtype)))

    def overlap(quad):
        polygon = np.zeros_like(binary)
        cv2.fillConvexPoly(polygon, np.round(quad).astype(np.int32), 255)
        return np.count_nonzero((polygon > 0) & (binary > 0)) / max(1, np.count_nonzero((polygon > 0) | (binary > 0)))

    best, best_score = None, float("-inf")
    for quad in candidates:
        agreement = overlap(quad)
        if agreement < 0.72:
            continue
        score = _score_page_quad(gray, quad, 0.06)
        if score is not None and score + agreement > best_score:
            best, best_score = _order_corners(quad), score + agreement
    if best is not None:
        return best
    rect = cv2.boxPoints(cv2.minAreaRect(contour))
    area = max(cv2.contourArea(rect), 1)
    # Segmentation can recognize dark paper that the classical brightness score rejects.
    if area / (h * w) <= 0.78 and cv2.contourArea(contour) / area >= 0.72 and overlap(rect) >= 0.72:
        rect[:, 0] = np.clip(rect[:, 0], 0, w - 1)
        rect[:, 1] = np.clip(rect[:, 1], 0, h - 1)
        ordered = _order_corners(rect)
        if not (max(ordered[0, 1], ordered[1, 1]) <= 3 and abs(ordered[1, 0] - ordered[0, 0]) > 0.55 * w):
            return ordered
    return None


def detect_page(frame_bgr, detector=None, *, preview=False):
    """Shared fit, with classical fallback on unavailable models or failed stills."""
    import cv2

    gray = frame_bgr if frame_bgr.ndim == 2 else cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    detection = detector.infer(frame_bgr) if detector is not None else None
    capability = detector.capabilities() if detector is not None else {"ready": False, "backend": "unavailable", "modelId": "unprovisioned"}
    ready = capability["ready"]
    metadata = {"backend": capability["backend"], "modelId": capability["modelId"], "score": None, "latencyMs": 0}
    quad = None
    if detection is not None:
        metadata = detection.metadata()
        if detection.score >= detector.score_min and (preview or detection.latencyMs <= 200):
            quad = fit_page_quad_from_mask(gray, detection.mask)
    if quad is None and (not preview or not ready):
        quad = find_page_quad(gray)
        metadata["fallback"] = "classical"
    return quad, metadata


# #FFD300 in BGR. Drawn only on the transient preview stream; capture/OCR always
# see the unmodified camera buffer.
PREVIEW_OVERLAY_BGR = (0, 211, 255)
PREVIEW_HIGHLIGHT_ALPHA = 0.10
PREVIEW_DETECT_MAX_WIDTH = 640


class PageQuadTracker:
    """EMA-smoothed page corners so the live overlay does not flicker every frame."""

    def __init__(self, alpha: float = 0.45, hold_frames: int = 6):
        self.alpha = alpha
        self.hold_frames = hold_frames
        self.quad = None
        self.missing = 0

    def update(self, quad):
        import numpy as np

        if quad is None:
            self.missing += 1
            if self.missing > self.hold_frames:
                self.quad = None
            return self.quad
        self.missing = 0
        incoming = np.asarray(quad, dtype="float32").reshape(4, 2)
        if self.quad is None:
            self.quad = incoming
        else:
            self.quad = (1.0 - self.alpha) * self.quad + self.alpha * incoming
        return self.quad


def detect_page_quad_for_preview(frame, max_width: int = PREVIEW_DETECT_MAX_WIDTH, detector=None):
    """Detect on a downscaled copy and return corners in full-frame pixels.

    Preview is 15 fps on the RDK X5; detecting on a ~640 px-wide frame keeps the
    overlay on-device without stalling the MJPEG generator.
    """
    import cv2

    if frame is None or frame.size == 0:
        return None
    h, w = frame.shape[:2]
    scale = min(1.0, max_width / float(w))
    small = frame if scale >= 1.0 else cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    quad, _ = detect_page(small, detector, preview=True)
    if quad is None:
        return None
    return quad / scale


def draw_page_overlay(
    frame,
    quad,
    color=PREVIEW_OVERLAY_BGR,
    highlight_alpha: float = PREVIEW_HIGHLIGHT_ALPHA,
):
    """Return a copy of `frame` with a #FFD300 page box and 10% fill highlight."""
    import cv2
    import numpy as np

    overlay = frame.copy()
    h, w = overlay.shape[:2]
    pts = np.round(np.asarray(quad, dtype="float32").reshape(4, 2)).astype(np.int32)
    pts[:, 0] = np.clip(pts[:, 0], 0, max(0, w - 1))
    pts[:, 1] = np.clip(pts[:, 1], 0, max(0, h - 1))
    poly = pts.reshape((-1, 1, 2))
    highlight = overlay.copy()
    cv2.fillConvexPoly(highlight, pts, color)
    cv2.addWeighted(highlight, highlight_alpha, overlay, 1.0 - highlight_alpha, 0, overlay)
    thickness = max(4, int(round(min(h, w) * 0.01)))
    cv2.polylines(overlay, [poly], True, color, thickness, cv2.LINE_AA)
    radius = max(5, thickness)
    for x, y in pts:
        cv2.circle(overlay, (int(x), int(y)), radius, color, -1, cv2.LINE_AA)
    return overlay


def annotate_preview_frame(frame, tracker: PageQuadTracker | None = None, detector=None):
    """Detect page edges on this camera frame and draw the live boundary box.

    Used only by `/preview/stream`. Capture still stores the raw sensor image.
    """
    quad = detect_page_quad_for_preview(frame, detector=detector)
    if tracker is not None:
        quad = tracker.update(quad)
    if quad is None:
        return frame
    return draw_page_overlay(frame, quad)


def preprocess(content: bytes, policy: QualityPolicy = DEFAULT_POLICY, detector=None) -> tuple[bytes, dict]:
    """Return the corrected page bytes and its quality/geometry record. The original is
    never modified; callers store both."""
    image = Image.open(io.BytesIO(content)).convert("RGB")
    if image.width * image.height > 20_000_000:
        raise ValueError("Image too large")
    try:
        import cv2
        import numpy as np
    except ImportError:
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue(), {
            "status": "REVIEW",
            "reasons": ["PERSPECTIVE_UNCERTAIN", "UNCALIBRATED_POLICY"],
            "adapter": "pillow-only",
            "policyVersion": policy.version,
            "originalDimensions": [image.width, image.height],
            "correctedDimensions": [image.width, image.height],
            "transform": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            "rotation": 0,
            "cropped": False,
        }

    frame = np.array(image)
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    quad, page_metadata = detect_page(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), detector)
    transform = np.eye(3)
    corrected = frame
    if quad is not None:
        tl, tr, br, bl = quad
        width = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
        height = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
        if width >= 8 and height >= 8:
            transform = cv2.getPerspectiveTransform(
                quad, np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
            )
            corrected = cv2.warpPerspective(frame, transform, (width, height))
        else:
            quad = None
    corrected_gray = cv2.cvtColor(corrected, cv2.COLOR_RGB2GRAY)
    assessment = assess_page(corrected_gray, quad=quad, frame_shape=gray.shape, policy=policy)
    output = io.BytesIO()
    Image.fromarray(corrected).save(output, format="PNG")
    return output.getvalue(), {
        "status": assessment.status,
        "reasons": assessment.reasons,
        "metrics": assessment.metrics,
        "adapter": "opencv",
        "pageDetector": page_metadata,
        "policyVersion": policy.version,
        "originalDimensions": [image.width, image.height],
        "correctedDimensions": [int(corrected.shape[1]), int(corrected.shape[0])],
        "pageCorners": None if quad is None else [[float(x), float(y)] for x, y in quad],
        "transform": transform.tolist(),
        "rotation": 0,
        "cropped": quad is not None,
    }


def fully_redacted_image(content: bytes) -> str:
    # Until box-level image redaction passes acceptance, image derivatives are not released;
    # the preview shows a fully blacked page so no original pixels are ever displayed remotely.
    image = Image.open(io.BytesIO(content))
    output = io.BytesIO()
    Image.new("RGB", image.size, "black").save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode()
