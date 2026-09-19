import base64
import io
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from PIL import Image


class Camera(Protocol):
    def capture(self) -> tuple[bytes, str]: ...


class FixtureCamera:
    def __init__(self, path: Path):
        self.path = path

    def capture(self):
        return self.path.read_bytes(), "text/plain" if self.path.suffix == ".txt" else "image/png"


class OpenCVCamera:
    def __init__(self, index: int = 0):
        self.index = index

    def capture(self):
        import cv2

        camera = cv2.VideoCapture(self.index)
        try:
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Camera unavailable")
            ok, encoded = cv2.imencode(".png", frame)
            if not ok:
                raise RuntimeError("Camera encoding failed")
            return encoded.tobytes(), "image/png"
        finally:
            camera.release()


@dataclass
class OCRResult:
    text: str
    confidence: float
    adapter: str


class OCR(Protocol):
    def extract(self, content: bytes, media_type: str) -> OCRResult: ...


class LocalOCR:
    def extract(self, content: bytes, media_type: str) -> OCRResult:
        if media_type == "text/plain":
            return OCRResult(content.decode("utf-8"), 1.0, "fixture-text")
        try:
            import pytesseract

            image = Image.open(io.BytesIO(content))
            data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, timeout=10)
            scores = [float(c) for c in data["conf"] if float(c) >= 0]
            return OCRResult(
                " ".join(t for t in data["text"] if t.strip()),
                sum(scores) / (100 * len(scores)) if scores else 0,
                "tesseract",
            )
        except (ImportError, RuntimeError, OSError):
            return OCRResult("", 0, "unavailable")


class PaddleOCRAdapter:
    """Optional PaddleOCR 3 adapter; initialized only by explicit local configuration."""

    def extract(self, content: bytes, media_type: str) -> OCRResult:
        if media_type == "text/plain":
            return LocalOCR().extract(content, media_type)
        detection = os.environ.get("EDGE_PADDLE_DETECTION_MODEL_DIR", "")
        recognition = os.environ.get("EDGE_PADDLE_RECOGNITION_MODEL_DIR", "")
        if not detection or not recognition or not Path(detection).is_dir() or not Path(recognition).is_dir():
            return OCRResult("", 0, "paddle-local-models-required")
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        import numpy as np
        from paddleocr import PaddleOCR

        result = list(
            PaddleOCR(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                text_detection_model_dir=detection,
                text_recognition_model_dir=recognition,
            ).predict(np.array(Image.open(io.BytesIO(content)).convert("RGB")))
        )
        texts, scores = [], []
        for page in result:
            texts.extend(page["rec_texts"])
            scores.extend(page["rec_scores"])
        return OCRResult("\n".join(texts), sum(scores) / len(scores) if scores else 0, "paddleocr")


def preprocess(content: bytes) -> tuple[bytes, dict]:
    image = Image.open(io.BytesIO(content)).convert("RGB")
    if image.width * image.height > 20_000_000:
        raise ValueError("Image too large")
    try:
        import cv2
        import numpy as np

        frame = np.array(image)
        gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        glare = float(np.mean(gray > 248))
        contours, _ = cv2.findContours(cv2.Canny(gray, 50, 150), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cropped = False
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
            polygon = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
            if len(polygon) != 4 or cv2.contourArea(polygon) < 0.2 * gray.size:
                continue
            pts = polygon.reshape(4, 2).astype("float32")
            sums, differences = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
            ordered = np.array(
                [pts[np.argmin(sums)], pts[np.argmin(differences)], pts[np.argmax(sums)], pts[np.argmax(differences)]],
                dtype="float32",
            )
            tl, tr, br, bl = ordered
            width = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
            height = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
            if width < 1 or height < 1:
                continue
            transform = cv2.getPerspectiveTransform(
                ordered, np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
            )
            frame = cv2.warpPerspective(frame, transform, (width, height))
            cropped = True
            break
        output = io.BytesIO()
        Image.fromarray(frame).save(output, format="PNG")
        return output.getvalue(), {
            "blurVariance": blur,
            "glareFraction": glare,
            "cropped": cropped,
            "confidence": 0.9 if blur > 70 and glare < 0.8 else 0.4,
        }
    except ImportError:
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue(), {"confidence": 0.4, "adapter": "pillow-only"}


def fully_redacted_image(content: bytes) -> str:
    # Until box-level OCR, face and signature adapters are calibrated, black out the entire page.
    image = Image.open(io.BytesIO(content))
    output = io.BytesIO()
    Image.new("RGB", image.size, "black").save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode()
