"""Exercise a camera that rejects a second open, like the intake's USB camera."""
import asyncio

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from gateway.app import Settings, create_app
from gateway.capture import OpenCVCamera


@pytest.fixture
def device(monkeypatch):
    state = {"active": 0, "opens": 0, "reads": 0, "fail": False}

    class ExclusiveCamera:
        def __init__(self, index):
            state["opens"] += 1
            self.opened = state["active"] == 0
            if self.opened:
                state["active"] += 1

        def isOpened(self):
            return self.opened

        def read(self):
            state["reads"] += 1
            return (False, None) if state["fail"] else (True, np.full((120, 160, 3), 180, np.uint8))

        def release(self):
            if self.opened:
                state["active"] -= 1
                self.opened = False

    monkeypatch.setattr(cv2, "VideoCapture", ExclusiveCamera)
    return state


def test_preview_capture_and_health_share_device(tmp_path, device, monkeypatch):
    settings = Settings(tmp_path)
    settings.local_token = "test-pairing"
    settings.probe_camera = True
    app = create_app(settings)
    # Make preview annotation visibly different from raw capture pixels.
    monkeypatch.setattr("gateway.app.annotate_preview_frame", lambda frame, *args: np.zeros_like(frame))
    preview_route = next(route for route in app.routes if route.path == "/preview/stream")
    preview = preview_route.endpoint()
    try:
        chunk = asyncio.run(anext(preview.body_iterator))
        assert b"Content-Type: image/jpeg" in chunk
        with TestClient(app, headers={"authorization": "Bearer test-pairing"}) as client:
            assert client.get("/health").json()["capabilities"]["camera"] is True
            intake = client.post("/v2/intakes", json={}).json()
            captured = client.post(f"/v2/intakes/{intake['intakeId']}/pages", json={"source": "camera"})
            assert captured.status_code == 200, captured.text
            assert captured.json()["pageCount"] == 1
            legacy = client.post("/capture", json={"caseId": "test-case", "source": "camera"})
            assert legacy.status_code == 200, legacy.text
            raw, media = app.state.camera.capture()
            assert media == "image/png"
            assert np.all(cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) == 180)
            assert device["opens"] == 1
            assert device["active"] == 1
    finally:
        asyncio.run(preview.body_iterator.aclose())
        asyncio.run(preview.background())
    assert device["active"] == 0
    assert app.state.camera.available()
    assert device["active"] == 0
    assert app.state.camera.available()
    assert device["opens"] == 1


def test_repeated_health_does_not_reopen_exclusive_device(device):
    camera = OpenCVCamera(warmup_frames=0)
    assert camera.available() is True
    assert camera.available() is True
    assert device["opens"] == 1
    assert device["active"] == 0


def test_capture_failure_releases_device_and_can_retry(device):
    camera = OpenCVCamera(warmup_frames=0)
    device["fail"] = True
    with pytest.raises(RuntimeError, match="Camera unavailable"):
        camera.capture()
    assert device["active"] == 0
    device["fail"] = False
    assert camera.capture()[1] == "image/png"
    assert device["active"] == 0


def test_capture_keeps_device_until_last_session_exits(device):
    camera = OpenCVCamera(warmup_frames=0)
    with camera.session():
        with camera.session():
            camera.capture()
        assert device["active"] == 1
    assert device["active"] == 0
    assert device["opens"] == 1
