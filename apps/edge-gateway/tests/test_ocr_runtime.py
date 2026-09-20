import hashlib
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image

from gateway.capture import LocalOCR, OCRResult, PaddleOCRAdapter
from gateway.ocr_runtime import RegionOCR, page_box

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")


def image_bytes(width=1200, height=600):
    output = io.BytesIO()
    Image.new("RGB", (width, height), (240, 10, 20)).save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def pinned(tmp_path):
    models = {}
    for role in ("textDetection", "textRecognition"):
        path = tmp_path / f"{role}.onnx"
        path.write_bytes(role.encode())
        models[role] = {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "modelId": role, "license": "test-only"}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"format": "lloyd-ocr-v1", "runtime": "rapidocr-onnxruntime==1.4.4", "models": models}))
    return str(path), hashlib.sha256(path.read_bytes()).hexdigest()


class Fallback:
    def __init__(self):
        self.calls = 0

    def extract(self, *_):
        self.calls += 1
        return OCRResult("fallback", 0.9, "test-fallback")


def test_persistent_batched_recognition_maps_full_resolution(pinned):
    loads, detections, batches = [], [], []

    def factory(paths, batch_size, threads):
        loads.append(paths)
        assert batch_size == 2

        def detect(frame):
            detections.append(frame.shape)
            # Reverse y order so recognition order cannot be confused with reading order.
            return np.array([[[32, y], [160, y], [160, y + 8], [32, y + 8]]
                             for y in [120, 96, 72, 48, 24]], np.float32), 0.01

        def recognize(crops):
            batches.append(len(crops))
            for crop in crops:
                assert crop.shape[:2] == (30, 480)  # Cropped from original, not the 320px detection image.
                assert tuple(crop[5, 5]) == (20, 10, 240)  # BGR, not RGB.
            return [("text", 0.9) for _ in crops], 0.02

        return detect, recognize

    adapter = RegionOCR(*pinned, batch_size=2, max_side=320, factory=factory)
    for _ in range(2):
        result = adapter.extract(image_bytes(), "image/png")
        assert result.adapter == "ppocr-onnx-cpu"
        assert [line["box"][1] for line in result.lines] == [90, 180, 270, 360, 450]
        assert result.lines[0]["box"] == [120, 90, 480, 30]
        assert result.width == 1200 and result.height == 600
        assert result.metrics["regionCount"] == 5
    assert len(loads) == 1 and len(detections) == 2
    assert batches == [2, 2, 1, 2, 2, 1]


def test_empty_detection_is_success_without_recognizer_or_fallback(pinned):
    fallback = Fallback()

    def forbidden(_):
        pytest.fail("Blank pages must not enter recognition")

    adapter = RegionOCR(*pinned, factory=lambda *_: (lambda _: ([], 0.01), forbidden), fallback=fallback)
    result = adapter.extract(image_bytes(), "image/png")
    assert result.text == "" and result.lines == [] and result.confidence == 0
    assert result.adapter == "ppocr-onnx-cpu" and fallback.calls == 0


def test_digest_mismatch_prevents_loading_and_falls_back(pinned):
    fallback = Fallback()
    adapter = RegionOCR(pinned[0], "0" * 64, factory=lambda *_: pytest.fail("Do not load"), fallback=fallback)
    assert not adapter.available()
    assert adapter.extract(image_bytes(), "image/png").metrics["error"] == "MANIFEST_DIGEST_MISMATCH"
    assert fallback.calls == 1


def test_bad_model_digest_prevents_loading(pinned):
    from pathlib import Path

    (Path(pinned[0]).parent / "textDetection.onnx").write_bytes(b"changed")
    adapter = RegionOCR(*pinned, factory=lambda *_: pytest.fail("Do not load"))
    assert adapter.capabilities()["error"] == "MODEL_DIGEST_MISMATCH"


def test_failure_is_bounded_and_falls_back(pinned):
    def broken(_):
        raise RuntimeError("PRIVATE IMAGE OR TEXT")

    adapter = RegionOCR(*pinned, factory=lambda *_: (broken, None), fallback=Fallback())
    result = adapter.extract(image_bytes(), "image/png")
    assert result.adapter == "test-fallback"
    assert result.metrics["error"] == "INFERENCE_FAILED"
    assert "PRIVATE" not in json.dumps(adapter.capabilities())


def test_concurrent_captures_do_not_interleave_engines(pinned):
    active = threading.Event()

    def detect(_):
        assert not active.is_set()
        active.set()
        time.sleep(0.01)
        return np.array([[[10, 10], [100, 10], [100, 30], [10, 30]]], np.float32), 0.01

    def recognize(crops):
        assert active.is_set()
        time.sleep(0.01)
        active.clear()
        return [("ok", 1.0)] * len(crops), 0.01

    adapter = RegionOCR(*pinned, factory=lambda *_: (detect, recognize), fallback=Fallback())
    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(lambda _: adapter.extract(image_bytes(), "image/png"), range(3)))
    assert all(result.text == "ok" for result in results)
    assert adapter.fallback.calls == 0


def test_paddle_pipeline_is_reused_and_batches_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("EDGE_PADDLE_DETECTION_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("EDGE_PADDLE_RECOGNITION_MODEL_DIR", str(tmp_path))
    instances = []

    class Pipeline:
        def __init__(self, **kwargs):
            instances.append(kwargs)

        def predict(self, frame):
            assert tuple(frame[0, 0]) == (20, 10, 240)
            return [{"rec_texts": ["hello"], "rec_scores": [0.95],
                     "rec_polys": [[[10, 10], [100, 10], [100, 30], [10, 30]]]}]

    adapter = PaddleOCRAdapter(pipeline_factory=Pipeline)
    for _ in range(2):
        assert adapter.extract(image_bytes(), "image/png").text == "hello"
    assert len(instances) == 1 and instances[0]["text_recognition_batch_size"] == 8


def test_polygon_coordinates_clamped_and_invalid_rejected():
    _, box = page_box([[-5, -5], [200, 0], [200, 80], [0, 80]], 100, 50)
    assert box == [0, 0, 99, 49]
    with pytest.raises(ValueError):
        page_box([[float("nan"), 0]] * 4, 100, 50)


def test_region_ocr_defaults_match_tested_x5_config(pinned, monkeypatch):
    for key in ("EDGE_OCR_BATCH_SIZE", "EDGE_OCR_THREADS", "EDGE_OCR_DETECT_MAX_SIDE"):
        monkeypatch.delenv(key, raising=False)
    adapter = RegionOCR(*pinned, factory=lambda *_: (None, None))
    caps = adapter.capabilities()
    assert caps["batchSize"] == 4
    assert caps["threads"] == 4
    assert caps["detectMaxSide"] == 960
    assert caps["fallback"] == "tesseract"
    assert caps["persistent"] is True


def test_health_reports_region_ocr_with_tesseract_fallback(pinned, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from gateway.app import Settings, create_app

    for key in ("EDGE_OCR_BATCH_SIZE", "EDGE_OCR_THREADS", "EDGE_OCR_DETECT_MAX_SIDE"):
        monkeypatch.delenv(key, raising=False)
    settings = Settings(tmp_path / "store")
    settings.probe_camera = False
    settings.local_token = ""
    ocr = RegionOCR(*pinned, factory=lambda *_: (None, None))
    with TestClient(create_app(settings, ocr=ocr)) as client:
        caps = client.get("/health").json()["capabilities"]["ocr"]
    assert caps["adapter"] == "region-ocr"
    assert caps["ready"] is True
    assert caps["fallback"] == "tesseract"
    assert caps["batchSize"] == 4
    assert caps["threads"] == 4
    assert caps["models"]["textRecognition"]["modelId"] == "textRecognition"


def test_tesseract_reports_capability_identity():
    caps = LocalOCR().capabilities()
    assert caps["adapter"] == "tesseract"
    assert caps["fallback"] is None
    assert "ready" in caps
