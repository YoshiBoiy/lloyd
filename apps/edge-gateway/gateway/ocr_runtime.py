"""Persistent, offline text detection -> full-resolution crops -> batched OCR.

The detector and recognizer are separately pinned PaddleOCR ONNX models. They
run on CPU, only for still capture analysis, never in the preview generator.
"""
import hashlib
import io
import json
import math
import os
import threading
import time
from pathlib import Path

from PIL import Image

from .capture import LocalOCR, OCRResult

# Board-tested still-image config: English recognizer, four threads, batches of four.
DEFAULT_BATCH_SIZE = 4
DEFAULT_THREADS = 4
DEFAULT_DETECT_MAX_SIDE = 960


class ModelUnavailable(ValueError):
    pass


def load_models(path, digest):
    if not path or not digest:
        raise ModelUnavailable("MODEL_UNAVAILABLE")
    manifest = Path(path)
    raw = manifest.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest.lower():
        raise ModelUnavailable("MANIFEST_DIGEST_MISMATCH")
    metadata = json.loads(raw)
    if metadata.get("format") != "lloyd-ocr-v1" or metadata.get("runtime") != "rapidocr-onnxruntime==1.4.4":
        raise ModelUnavailable("INVALID_MANIFEST")
    paths = {}
    for role in ("textDetection", "textRecognition"):
        entry = metadata["models"][role]
        model = (manifest.parent / entry["path"]).resolve()
        if not model.is_relative_to(manifest.parent.resolve()) or model.suffix != ".onnx":
            raise ModelUnavailable("INVALID_MODEL_PATH")
        if not entry.get("license") or not entry.get("modelId"):
            raise ModelUnavailable("INVALID_MODEL_METADATA")
        if hashlib.sha256(model.read_bytes()).hexdigest() != entry["sha256"]:
            raise ModelUnavailable("MODEL_DIGEST_MISMATCH")
        paths[role] = str(model)
    return metadata, paths


def build_engines(paths, batch_size, threads):
    from importlib.metadata import version
    from rapidocr_onnxruntime.ch_ppocr_det import TextDetector
    from rapidocr_onnxruntime.ch_ppocr_rec import TextRecognizer

    if version("rapidocr-onnxruntime") != "1.4.4":
        raise ModelUnavailable("RUNTIME_VERSION_MISMATCH")
    common = {"intra_op_num_threads": threads, "inter_op_num_threads": 1, "use_cuda": False, "use_dml": False}
    detector = TextDetector({**common, "model_path": paths["textDetection"],
                             "limit_side_len": 960, "limit_type": "max", "mean": [0.5] * 3,
                             "std": [0.5] * 3, "thresh": 0.3, "box_thresh": 0.5,
                             "max_candidates": 1000, "unclip_ratio": 1.6,
                             "use_dilation": True, "score_mode": "fast"})
    recognizer = TextRecognizer({**common, "model_path": paths["textRecognition"],
                                "rec_img_shape": [3, 48, 320], "rec_batch_num": batch_size})
    return detector, recognizer


def page_box(polygon, width, height):
    import numpy as np

    pts = np.asarray(polygon, dtype=np.float32)
    if pts.shape != (4, 2) or not np.isfinite(pts).all():
        raise ValueError("Invalid polygon")
    pts = pts.copy()
    pts[:, 0] = np.clip(pts[:, 0], 0, width - 1)
    pts[:, 1] = np.clip(pts[:, 1], 0, height - 1)
    x, y = np.floor(pts.min(axis=0)).astype(int)
    right, bottom = np.ceil(pts.max(axis=0)).astype(int)
    return pts, [int(x), int(y), max(1, int(right - x)), max(1, int(bottom - y))]


def rectify_region(frame, quad):
    """Detector corners are TL, TR, BR, BL in corrected-page coordinates."""
    import cv2
    import numpy as np

    width = max(2, int(round(max(np.linalg.norm(quad[0] - quad[1]), np.linalg.norm(quad[2] - quad[3])))))
    height = max(2, int(round(max(np.linalg.norm(quad[0] - quad[3]), np.linalg.norm(quad[1] - quad[2])))))
    if width * height > 4_000_000:
        raise ValueError("Region too large")
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], np.float32)
    transform = cv2.getPerspectiveTransform(quad, target)
    crop = cv2.warpPerspective(frame, transform, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    if height / width >= 1.5:
        crop = np.rot90(crop).copy()
    return crop


class RegionOCR:
    def __init__(self, manifest=None, digest=None, *, batch_size=None, threads=None,
                 max_side=None, factory=None, fallback=None):
        self.manifest_path = manifest if manifest is not None else os.environ.get("EDGE_OCR_MANIFEST", "")
        self.digest = digest if digest is not None else os.environ.get("EDGE_OCR_MANIFEST_SHA256", "")
        self.batch_size = int(batch_size if batch_size is not None else os.environ.get("EDGE_OCR_BATCH_SIZE", str(DEFAULT_BATCH_SIZE)))
        self.threads = int(threads if threads is not None else os.environ.get("EDGE_OCR_THREADS", str(DEFAULT_THREADS)))
        self.max_side = int(max_side if max_side is not None else os.environ.get("EDGE_OCR_DETECT_MAX_SIDE", str(DEFAULT_DETECT_MAX_SIDE)))
        self.fallback = fallback if fallback is not None else LocalOCR()
        self.lock = threading.Lock()
        self.engines = None
        self.metadata = {}
        self.error = None
        try:
            if not 1 <= self.batch_size <= 32 or not 1 <= self.threads <= 8 or not 320 <= self.max_side <= 2000:
                raise ModelUnavailable("INVALID_CONFIGURATION")
            self.metadata, paths = load_models(self.manifest_path, self.digest)
            self.engines = (factory or build_engines)(paths, self.batch_size, self.threads)
        except ModelUnavailable as exc:
            self.error = str(exc)
        except Exception:
            self.error = "MODEL_LOAD_FAILED"

    def available(self):
        return self.engines is not None

    def capabilities(self):
        return {
            "adapter": "region-ocr", "ready": self.available(), "backend": "cpu" if self.available() else "unavailable",
            "runtimeVersion": "rapidocr-onnxruntime==1.4.4", "persistent": True,
            "batchSize": self.batch_size, "threads": self.threads, "detectMaxSide": self.max_side,
            "artifactDigest": self.digest or None, "error": self.error,
            "models": {role: {key: item[key] for key in ("modelId", "sha256", "license")}
                       for role, item in self.metadata.get("models", {}).items()},
            "fallback": "tesseract", "coordinateSpace": "corrected-page",
        }

    def _fallback(self, content, media_type, error):
        result = self.fallback.extract(content, media_type)
        result.metrics.update({"fallbackFrom": "region-ocr", "error": error, "backend": "cpu"})
        return result

    def extract(self, content, media_type):
        if media_type == "text/plain":
            return LocalOCR().extract(content, media_type)
        if not self.available():
            return self._fallback(content, media_type, self.error)
        started = time.perf_counter()
        try:
            import cv2
            import numpy as np

            with Image.open(io.BytesIO(content)) as image:
                if image.width * image.height > 20_000_000:
                    raise ValueError("Image too large")
                frame = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)
            height, width = frame.shape[:2]
            scale = min(1.0, self.max_side / max(height, width))
            small = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else frame
            # The detector preprocessor and recognizer are mutable; serialize a complete
            # page to prevent concurrent captures from mixing dimensions or predictions.
            with self.lock:
                detector, recognizer = self.engines
                boxes, detect_seconds = detector(small)
                boxes = [] if boxes is None else boxes
                if len(boxes) > 512:
                    raise ValueError("Region limit exceeded")
                regions = []
                for box in boxes:
                    quad = np.asarray(box, dtype=np.float32) * [width / small.shape[1], height / small.shape[0]]
                    quad, bounds = page_box(quad, width, height)
                    if bounds[2] < 3 or bounds[3] < 3 or abs(cv2.contourArea(quad)) < 4:
                        continue
                    regions.append((quad, bounds))
                # Sort crops by aspect ratio so a long line does not pad every short
                # line in its batch; the association travels with each crop.
                regions.sort(key=lambda r: r[1][2] / r[1][3])
                recognized = []
                recognition_seconds = 0.0
                for start in range(0, len(regions), self.batch_size):
                    batch = regions[start:start + self.batch_size]
                    crops = [rectify_region(frame, quad) for quad, _ in batch]
                    results, seconds = recognizer(crops)
                    if len(results) != len(batch):
                        raise ValueError("Recognition count mismatch")
                    recognition_seconds += seconds
                    recognized.extend((region, prediction) for region, prediction in zip(batch, results))
            lines = []
            for (quad, bounds), prediction in recognized:
                text, confidence = str(prediction[0]), float(prediction[1])
                if not math.isfinite(confidence):
                    raise ValueError("Invalid confidence")
                if not text.strip():
                    continue
                # Keep low-confidence text for quality review rather than silently
                # removing potential sensitive information from the local pipeline.
                lines.append({"text": text, "confidence": max(0.0, min(1.0, confidence)),
                              "box": bounds, "polygon": quad.tolist(), "words": []})
            lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
            for index, line in enumerate(lines):
                line["id"] = f"line_{index}"
            self.error = None
            return OCRResult("\n".join(line["text"] for line in lines),
                             sum(line["confidence"] for line in lines) / len(lines) if lines else 0,
                             "ppocr-onnx-cpu", lines, width, height,
                             metrics={"backend": "cpu", "coordinateSpace": "corrected-page",
                                      "regionCount": len(regions), "batchSize": self.batch_size,
                                      "detectMs": round(detect_seconds * 1000, 2),
                                      "recognizeMs": round(recognition_seconds * 1000, 2),
                                      "latencyMs": round((time.perf_counter() - started) * 1000, 2)})
        except Exception:
            self.error = "INFERENCE_FAILED"
            return self._fallback(content, media_type, self.error)
