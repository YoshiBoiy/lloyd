"""Offline page segmentation, separate from semantic NER.

The CPU PNG backend is an explicit test fixture, not a learned detector. BPU
loading stays unavailable until a one-class artifact passes training/export
acceptance. Never download weights or substitute stock COCO models.
"""
import hashlib
import io
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class PageDetection:
    mask: object
    boxXyxy: list[int]
    score: float
    latencyMs: float
    modelId: str
    artifactDigest: str
    backend: str

    def metadata(self):
        return {key: getattr(self, key) for key in ("backend", "modelId", "score", "latencyMs")}


class CpuMaskFixture:
    def __init__(self, content):
        import cv2
        import numpy as np
        from PIL import Image

        with Image.open(io.BytesIO(content)) as image:
            if image.format != "PNG" or image.width * image.height > 20_000_000:
                raise ValueError("Invalid fixture")
            self.mask = np.asarray(image.convert("L"))
        self.mask = (self.mask > 127).astype(np.uint8) * 255
        self.cv2 = cv2

    def infer(self, frame):
        return self.cv2.resize(self.mask, (frame.shape[1], frame.shape[0]), interpolation=self.cv2.INTER_NEAREST)


class PageDetector:
    def __init__(self, path="", digest="", backend="auto", score_min=0.35, input_size=640):
        self.model = None
        self.digest = None
        self.error = None
        self.score_min = score_min
        self.input_size = input_size
        if backend == "off":
            return
        if backend not in {"auto", "cpu", "bpu"} or input_size != 640 or not 0 <= score_min <= 1:
            self.error = "INVALID_CONFIGURATION"
            return
        if not path or not digest:
            self.error = "MODEL_UNAVAILABLE"
            return
        try:
            content = Path(path).read_bytes()
            actual = hashlib.sha256(content).hexdigest()
            if actual != digest.lower():
                self.error = "DIGEST_MISMATCH"
                return
            # Explicit fixture mode only: auto must never mistake a PNG for a model.
            if backend != "cpu":
                self.error = "BPU_ARTIFACT_NOT_VALIDATED"
                return
            self.model = CpuMaskFixture(content)
            self.digest = actual
        except Exception:
            # Exception messages may contain paths/image data; expose bounded codes only.
            self.error = "MODEL_LOAD_FAILED"

    def capabilities(self):
        return {
            "ready": self.model is not None,
            "modelId": "cpu-mask-fixture" if self.model is not None else "unprovisioned",
            "artifactDigest": self.digest,
            "runtimeVersion": "page-detector-v1",
            "backend": "cpu" if self.model is not None else "unavailable",
            "input": "png-mask-fixture" if self.model is not None else f"{self.input_size}x{self.input_size}_nv12",
            "calibration": "UNCALIBRATED",
            "error": self.error,
        }

    def infer(self, frame_bgr):
        if self.model is None:
            return None
        started = time.perf_counter()
        try:
            import numpy as np

            mask = self.model.infer(frame_bgr)
            ys, xs = np.nonzero(mask)
            if not len(xs):
                return None
            return PageDetection(
                mask, [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                1.0, (time.perf_counter() - started) * 1000,
                "cpu-mask-fixture", self.digest, "cpu",
            )
        except Exception:
            self.model = None
            self.error = "INFERENCE_FAILED"
            return None
