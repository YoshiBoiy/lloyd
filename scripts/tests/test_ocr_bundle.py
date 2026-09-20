import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location("edge_bundle", Path(__file__).parents[1] / "build-edge-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def source_models(root):
    root.mkdir()
    models = {}
    for role in ("textDetection", "textRecognition"):
        path = root / (role + ".onnx")
        path.write_bytes(role.encode())
        models[role] = {"path": path.name, "sha256": bundle.sha256_file(path), "modelId": role, "license": "Apache-2.0"}
    (root / "manifest.json").write_text(json.dumps({"format": "lloyd-ocr-v1", "runtime": "rapidocr-onnxruntime==1.4.4", "models": models}))
    (root / "LICENSE").write_text("test-license")
    (root / "NOTICE").write_text("test-notice")
    return root


def test_ocr_bundle_pins_and_detects_tampering(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle, "freeze_lock", lambda _: None)
    source = source_models(tmp_path / "source")
    out = tmp_path / "bundle"
    args = SimpleNamespace(out=str(out), version="test", model=None, detector=None, wheelhouse=None, ocr_models=str(source))
    assert bundle.build(args) == 0
    path = out / "bundle.manifest.json"
    meta = json.loads(path.read_text())["models"]["ocr"]
    assert meta["env"]["EDGE_OCR"] == "region"
    assert meta["env"]["EDGE_OCR_MANIFEST_SHA256"] == bundle.sha256_file(out / "models/ocr/manifest.json")
    assert meta["env"]["EDGE_OCR_BATCH_SIZE"] == "4"
    assert meta["env"]["EDGE_OCR_THREADS"] == "4"
    assert meta["env"]["EDGE_OCR_DETECT_MAX_SIDE"] == "960"
    assert bundle.verify(SimpleNamespace(manifest=str(path))) == 0
    (out / "models/ocr/textRecognition.onnx").write_bytes(b"wrong")
    assert bundle.verify(SimpleNamespace(manifest=str(path))) == 1


def test_bundle_rejects_mismatched_source_model(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle, "freeze_lock", lambda _: None)
    source = source_models(tmp_path / "source")
    (source / "textDetection.onnx").write_bytes(b"wrong")
    args = SimpleNamespace(out=str(tmp_path / "bundle"), version="test", model=None, detector=None, wheelhouse=None, ocr_models=str(source))
    with pytest.raises(ValueError, match="pin"):
        bundle.build(args)
