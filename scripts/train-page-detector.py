#!/usr/bin/env python3
"""Local-only YOLOv8n-seg training. Never install its dependencies on the X5."""
import argparse
import hashlib
import json
import math
import platform
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def validate_dataset(root):
    """Require reviewed polygon labels and provenance before starting a costly run."""
    provenance = json.loads((root / "provenance.json").read_text())
    counts = {"train": 0, "val": 0}
    negatives = 0
    board = 0
    seen = set()
    groups = {}
    positives = {"train": 0, "val": 0}
    for split in counts:
        stems = set()
        images = sorted((root / "images" / split).glob("*"))
        for image in images:
            if image.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            if image.stem in stems:
                raise ValueError("Image basenames must be unique within each split")
            stems.add(image.stem)
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if digest in seen:
                raise ValueError("Duplicate image content in dataset")
            seen.add(digest)
            info = provenance[image.relative_to(root).as_posix()]
            if not info.get("source") or not info.get("license") or not info.get("captureGroup"):
                raise ValueError("Each image needs source, license, and captureGroup")
            group = info["captureGroup"]
            if group in groups and groups[group] != split:
                raise ValueError("A capture group crosses train and validation splits")
            groups[group] = split
            label = root / "labels" / split / (image.stem + ".txt")
            lines = [line.split() for line in label.read_text().splitlines() if line.strip()]
            for line in lines:
                if line[0] != "0" or len(line) < 7 or len(line) % 2 != 1:
                    raise ValueError("Labels must be class 0 page polygons, not detection boxes")
                coords = [float(value) for value in line[1:]]
                if any(not math.isfinite(value) or not 0 <= value <= 1 for value in coords):
                    raise ValueError("Polygon coordinates must be normalized to [0, 1]")
                points = list(zip(coords[::2], coords[1::2]))
                area = abs(sum(x * points[(i + 1) % len(points)][1] - y * points[(i + 1) % len(points)][0]
                               for i, (x, y) in enumerate(points))) / 2
                if area <= 0:
                    raise ValueError("Degenerate page polygon")
            positives[split] += int(bool(lines))
            counts[split] += 1
            negatives += int(split == "train" and not lines)
            board += int(info["source"] == "rdk-x5")
    if counts["train"] < 200 or counts["val"] < 40:
        raise ValueError("Need at least 200 train and 40 validation images")
    if not all(positives.values()):
        raise ValueError("Both splits need positive page examples")
    if negatives < 0.3 * counts["train"]:
        raise ValueError("At least 30% of training images must be reviewed negatives (empty labels)")
    if board < 40:
        raise ValueError("At least 40 images must come from this RDK X5 camera")
    return {**counts, "trainNegatives": negatives, "boardImages": board}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=REPO / "datasets/page-seg")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--weights", type=Path, help="Locally provisioned yolov8n-seg.pt; no implicit download")
    parser.add_argument("--license", choices=["AGPL-3.0", "Ultralytics-Enterprise"])
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--device", default="cpu", help="cpu, mps, or CUDA device index")
    parser.add_argument("--output", type=Path, default=REPO / "dist/page-detector-training")
    args = parser.parse_args()
    root = args.dataset.resolve()
    try:
        counts = validate_dataset(root)
    except (ValueError, KeyError, OSError) as exc:
        parser.error(str(exc))
    if args.check_only:
        print(json.dumps(counts))
        return
    if platform.system() == "Linux" and platform.machine().lower() in {"aarch64", "arm64"}:
        parser.error("Train on a laptop or x86 machine, never on the RDK")
    if not args.weights or not args.weights.is_file() or not args.license:
        parser.error("Training requires local --weights and the applicable --license")
    if args.epochs < 20:
        parser.error("Need at least 20 epochs for the final mosaic-off phase")
    import ultralytics
    from ultralytics import YOLO, settings

    # Disable external experiment integrations; images remain local.
    settings.update({"sync": False, "hub": False, "wandb": False, "comet": False,
                     "clearml": False, "mlflow": False, "neptune": False})
    model = YOLO(str(args.weights.resolve()), task="segment")
    config = model.model.yaml
    if model.task != "segment" or config.get("scale") != "n" or "yolov8" not in str(config.get("yaml_file", "")):
        parser.error("Weights must be stock YOLOv8n-seg")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    data = output / "data.yaml"
    data.write_text(f"path: {json.dumps(str(root))}\ntrain: images/train\nval: images/val\nnames:\n  0: page\n")
    model.train(data=str(data), imgsz=640, epochs=args.epochs, device=args.device,
                project=str(output), name="train", close_mosaic=20, degrees=15,
                scale=0.4, perspective=0.0, hsv_h=0.015, hsv_s=0.4, hsv_v=0.3,
                seed=42, deterministic=True)
    best = Path(model.trainer.best)
    trained = YOLO(str(best), task="segment")
    if trained.names != {0: "page"}:
        raise ValueError("Trained head must have exactly one class: page")
    validation = trained.val(data=str(data), imgsz=640, device=args.device)
    shutil.copy2(best, output / "page-v1.pt")
    git_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    metrics = {
        "modelId": "page-v1", "license": args.license,
        "epochsRequested": args.epochs, "epochsCompleted": int(model.trainer.epoch) + 1,
        "images": counts, "gitCommit": git_commit,
        "trainScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "ultralyticsVersion": ultralytics.__version__,
        "maskMap50": float(validation.seg.map50), "maskMap50to95": float(validation.seg.map),
        "valMaskIoU": None, "boardHoldoutIoU": None,
        "acceptance": "PENDING_MASK_IOU_AND_BOARD_HOLDOUT",
    }
    (output / "page-v1-metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print("Training complete. Measure mask IoU and the 10-image board holdout before export; mAP is not IoU.")


if __name__ == "__main__":
    main()
