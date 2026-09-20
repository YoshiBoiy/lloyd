import hashlib
import io

import pytest
from PIL import Image

from gateway.capture import PageQuadTracker, annotate_preview_frame, detect_page, fit_page_quad_from_mask, preprocess
from gateway.page_detect import PageDetector
from test_v2 import _handheld_flyer_under_lights, _quad_iou

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")


def fixture_detector(tmp_path, mask):
    path = tmp_path / "mask.png"
    Image.fromarray(mask).save(path)
    return PageDetector(str(path), hashlib.sha256(path.read_bytes()).hexdigest(), "cpu")


def scene():
    frame, page = _handheld_flyer_under_lights()
    mask = np.zeros(frame.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, page, 255)
    return frame, page, mask


def test_mask_fits_flyer_and_edges_are_roi_only(tmp_path, monkeypatch):
    frame, page, mask = scene()
    sizes = []
    canny = cv2.Canny

    def traced(gray, *args, **kwargs):
        sizes.append(gray.size)
        return canny(gray, *args, **kwargs)

    monkeypatch.setattr(cv2, "Canny", traced)
    quad, metadata = detect_page(frame, fixture_detector(tmp_path, mask), preview=True)
    assert _quad_iou(quad, page, frame.shape) >= 0.72
    assert sizes and max(sizes) < frame.shape[0] * frame.shape[1] / 2
    assert metadata["backend"] == "cpu"
    assert "mask" not in metadata


def test_preview_copy_safe_and_capture_uses_same_fit(tmp_path):
    frame, page, mask = scene()
    detector = fixture_detector(tmp_path, mask)
    original = frame.copy()
    result = annotate_preview_frame(frame, detector=detector)
    assert not np.array_equal(result, original)
    assert np.array_equal(frame, original)
    encoded = io.BytesIO()
    Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).save(encoded, format="PNG")
    raw = encoded.getvalue()
    _, quality = preprocess(raw, detector=detector)
    assert raw == encoded.getvalue()
    assert _quad_iou(quality["pageCorners"], page, frame.shape) >= 0.72
    assert quality["pageDetector"]["modelId"] == "cpu-mask-fixture"
    assert "mask" not in quality["pageDetector"]


def test_empty_mask_abstains_preview_but_capture_falls_back(tmp_path):
    frame, page, mask = scene()
    detector = fixture_detector(tmp_path, np.zeros_like(mask))
    assert detector.capabilities()["ready"]
    tracker = PageQuadTracker()
    tracker.update(page)
    for _ in range(tracker.hold_frames):
        assert not np.array_equal(annotate_preview_frame(frame, tracker, detector), frame)
    assert np.array_equal(annotate_preview_frame(frame, tracker, detector), frame)
    quad, metadata = detect_page(frame, detector)
    assert _quad_iou(quad, page, frame.shape) >= 0.72
    assert metadata["fallback"] == "classical"


def test_digest_and_missing_file_fallback(tmp_path):
    frame, page, mask = scene()
    good = fixture_detector(tmp_path, mask)
    assert good.capabilities()["ready"]
    for detector in [PageDetector(), PageDetector(str(tmp_path / "missing"), "a" * 64, "cpu"),
                     PageDetector(str(tmp_path / "mask.png"), "0" * 64, "cpu")]:
        assert not detector.capabilities()["ready"]
        assert detector.infer(frame) is None
        quad, metadata = detect_page(frame, detector, preview=True)
        assert _quad_iou(quad, page, frame.shape) >= 0.72
        assert metadata["backend"] == "unavailable"
        assert metadata["fallback"] == "classical"


def test_low_score_and_failure(tmp_path):
    frame, _, mask = scene()
    detector = fixture_detector(tmp_path, mask)
    detection = detector.infer(frame)
    detection.score = 0.1
    detector.infer = lambda frame: detection
    assert detect_page(frame, detector, preview=True)[0] is None
    detector = fixture_detector(tmp_path, mask)
    detector.model.infer = lambda frame: 1 / 0
    assert detect_page(frame, detector, preview=True)[0] is not None
    assert detector.capabilities()["error"] == "INFERENCE_FAILED"


def test_invalid_masks():
    frame, _, mask = scene()
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    for invalid in [None, np.zeros_like(mask), np.ones_like(mask), np.zeros((0, 0)),
                    np.full(mask.shape, np.nan), np.zeros((*mask.shape, 3))]:
        assert fit_page_quad_from_mask(gray, invalid) is None


def test_auto_never_loads_cpu_fixture(tmp_path):
    _, _, mask = scene()
    detector = fixture_detector(tmp_path, mask)
    auto = PageDetector(str(tmp_path / "mask.png"), detector.digest)
    assert not auto.capabilities()["ready"]
    assert auto.capabilities()["backend"] == "unavailable"


def test_health_keeps_page_and_ner_capabilities_separate(tmp_path):
    from fastapi.testclient import TestClient
    from gateway.app import Settings, create_app

    _, _, mask = scene()
    settings = Settings(tmp_path / "store")
    settings.probe_camera = False
    settings.local_token = ""
    detector = fixture_detector(tmp_path, mask)
    with TestClient(create_app(settings, page_detector=detector)) as client:
        capabilities = client.get("/health").json()["capabilities"]
    assert "detector" in capabilities
    assert capabilities["pageDetector"]["ready"] is True
    assert capabilities["pageDetector"]["modelId"] == "cpu-mask-fixture"
    assert capabilities["pageDetector"]["artifactDigest"] == detector.digest
    assert capabilities["detector"] != capabilities["pageDetector"]


def test_corrupt_pinned_artifact_is_unavailable(tmp_path):
    path = tmp_path / "corrupt.png"
    path.write_bytes(b"not an image")
    detector = PageDetector(str(path), hashlib.sha256(path.read_bytes()).hexdigest(), "cpu")
    assert detector.capabilities()["ready"] is False
    assert detector.capabilities()["error"] == "MODEL_LOAD_FAILED"
