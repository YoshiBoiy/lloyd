# Local page-seg training

No training images or weights are included. This is step 2 preparation; the
training/IoU gate has not passed and the production BPU adapter is not enabled.

The proposed Kaggle `trainingdatapro/text-detection-in-the-documents` dataset
labels text titles, paragraphs, tables, and handwriting with boxes. These are
not page-boundary polygons. Do not relabel the text boxes as `page`. Its dataset
card lists CC BY-NC-ND 4.0 and directs commercial users to the provider:
https://www.kaggle.com/datasets/trainingdatapro/text-detection-in-the-documents

SmartDoc 2015 Challenge 1 is a more relevant source of document outlines; its
publisher supplies frame images and ground truth under CC BY 4.0. Preserve the
required attribution and split by source video/document to avoid adjacent-frame
leakage: https://github.com/jchazalon/smartdoc15-ch1-dataset

Prepare `images/train`, `images/val`, `labels/train`, and `labels/val` locally.
Every image needs a same-stem `.txt` label. Each row is a YOLO-seg polygon:
`0 x1 y1 x2 y2 ...`, normalized to [0, 1], tracing the paper, not its text or a
hand. Empty label files are explicitly reviewed negative examples. Use at least
200 train images (30% negatives), 40 validation images, and 40 images from this
X5 camera. Keep at least 10 additional labeled ceiling-and-flyer X5 images in
`holdout/`; do not put those in the training or validation split. Put 20–50 X5
calibration photos in `calib/` for the later export stage.

Create a gitignored `provenance.json` mapping every relative image path:

```json
{
  "images/train/x5_001.png": {
    "source": "rdk-x5",
    "license": "operator-owned",
    "captureGroup": "room-a-session-1"
  }
}
```

A capture group must stay in one split. For external images, identify the source
and its license; use a capture group unique to the source video/document. Exact
duplicate image content is rejected. Visually review near duplicates and labels.
Keep basenames unique within each split, including across image extensions.

Check the dataset without importing PyTorch or Ultralytics:

```sh
python3 scripts/train-page-detector.py --check-only
```

On the laptop or an operator-controlled x86 machine, use a separate training
venv with Ultralytics. Provision the official `yolov8n-seg.pt` locally; the script
requires an existing file. Record the applicable Ultralytics weight license:

```sh
python scripts/train-page-detector.py \
  --weights /absolute/path/yolov8n-seg.pt \
  --license AGPL-3.0 --device mps --epochs 100
```

Use `--device 0` for CUDA or `--device cpu` for CPU. This training setup is not
installed in the gateway venv or copied to the X5. It uses stock YOLOv8n-seg and
does not modify `forward`. Training outputs go to gitignored
`dist/page-detector-training/`, including `page-v1.pt` and metrics with script
identity. Training has not been executed or verified with actual weights yet.
Ultralytics mAP is recorded as mAP, never presented as mask IoU. The metrics stay
pending until validation mask IoU is at least 0.80 and the 10-image X5 holdout IoU
is at least 0.72. Do not begin export/BPU integration before those gates pass.
