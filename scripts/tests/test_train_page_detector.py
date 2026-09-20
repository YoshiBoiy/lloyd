import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("train_page", Path(__file__).parents[1] / "train-page-detector.py")
train_page = importlib.util.module_from_spec(spec)
spec.loader.exec_module(train_page)


@pytest.fixture
def dataset(tmp_path):
    provenance = {}
    for split, count in [("train", 200), ("val", 40)]:
        (tmp_path / "images" / split).mkdir(parents=True)
        (tmp_path / "labels" / split).mkdir(parents=True)
        for i in range(count):
            relative = f"images/{split}/{i}.png"
            # Content identities are enough for the provenance/label preflight;
            # image decoding is handled by the trainer.
            (tmp_path / relative).write_bytes(relative.encode())
            (tmp_path / "labels" / split / f"{i}.txt").write_text(
                "" if split == "train" and i < 60 else "0 0.1 0.1 0.9 0.1 0.9 0.9 0.1 0.9\n"
            )
            provenance[relative] = {"source": "rdk-x5" if i < 20 else "public-source",
                                    "license": "test-only", "captureGroup": f"{split}-{i}"}
    (tmp_path / "provenance.json").write_text(json.dumps(provenance))
    return tmp_path


def test_dataset_counts(dataset):
    assert train_page.validate_dataset(dataset) == {"train": 200, "val": 40, "trainNegatives": 60, "boardImages": 40}


def test_rejects_text_detection_boxes(dataset):
    (dataset / "labels/val/0.txt").write_text("0 0.5 0.5 0.2 0.2")
    with pytest.raises(ValueError, match="polygons"):
        train_page.validate_dataset(dataset)


def test_rejects_cross_split_capture_group(dataset):
    path = dataset / "provenance.json"
    data = json.loads(path.read_text())
    data["images/val/0.png"]["captureGroup"] = "train-0"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="capture group"):
        train_page.validate_dataset(dataset)


def test_rejects_duplicate_image(dataset):
    (dataset / "images/val/0.png").write_bytes((dataset / "images/train/0.png").read_bytes())
    with pytest.raises(ValueError, match="Duplicate"):
        train_page.validate_dataset(dataset)


def test_requires_board_images(dataset):
    path = dataset / "provenance.json"
    data = json.loads(path.read_text())
    for item in data.values():
        item["source"] = "public-source"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="RDK X5"):
        train_page.validate_dataset(dataset)
