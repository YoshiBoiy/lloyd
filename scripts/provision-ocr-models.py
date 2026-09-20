#!/usr/bin/env python3
"""Extract pinned OCR models from a locally downloaded official runtime wheel.

This is an operator provisioning step, never a gateway runtime download.
"""
import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

WHEEL_SHA256 = "971d7d5f223a7a808662229df1ef69893809d8457d834e6373d3854bc1782cbf"
MODELS = {
    "textDetection": "ch_PP-OCRv4_det_infer.onnx",
    "textRecognition": "ch_PP-OCRv4_rec_infer.onnx",
}


ENGLISH_SHA256 = "e8770c967605983d1570cdf5352041dfb68fa0c21664f49f47b155abd3e0e318"
ENGLISH_SOURCE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/rec/en_PP-OCRv4_rec_mobile.onnx"


def provision(wheel, out, english_recognizer=None):
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != WHEEL_SHA256:
        raise ValueError("Expected the official rapidocr_onnxruntime 1.4.4 wheel digest")
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"format": "lloyd-ocr-v1", "runtime": "rapidocr-onnxruntime==1.4.4",
                "sourceWheelSha256": WHEEL_SHA256, "models": {}}
    with zipfile.ZipFile(wheel) as archive:
        for role, name in MODELS.items():
            content = archive.read("rapidocr_onnxruntime/models/" + name)
            (out / name).write_bytes(content)
            manifest["models"][role] = {"path": name, "modelId": name.removesuffix(".onnx"),
                                        "sha256": hashlib.sha256(content).hexdigest(),
                                        "license": "Apache-2.0", "source": "https://github.com/RapidAI/RapidOCR"}
        for name in archive.namelist():
            if name.endswith('.dist-info/LICENSE'):
                (out / 'LICENSE').write_bytes(archive.read(name))
    if english_recognizer is not None:
        content = english_recognizer.read_bytes()
        if hashlib.sha256(content).hexdigest() != ENGLISH_SHA256:
            raise ValueError("English recognizer digest does not match the publisher's pin")
        name = "en_PP-OCRv4_rec_mobile.onnx"
        (out / name).write_bytes(content)
        (out / MODELS["textRecognition"]).unlink()
        manifest["models"]["textRecognition"] = {
            "path": name, "modelId": "en_PP-OCRv4_rec_mobile", "sha256": ENGLISH_SHA256,
            "license": "Apache-2.0", "source": ENGLISH_SOURCE, "languages": ["en"],
        }
    shutil.copy2(Path(__file__).resolve().parents[1] / "LICENSES/RapidOCR-Apache-2.0.txt", out / "LICENSE")
    (out / 'NOTICE').write_text(
        'OCR weights derived from PaddleOCR, Copyright PaddlePaddle Authors.\n'
        'ONNX conversion distributed by RapidAI/RapidOCR under Apache-2.0.\n'
        'https://github.com/PaddlePaddle/PaddleOCR\nhttps://github.com/RapidAI/RapidOCR\n'
    )
    path = out / 'manifest.json'
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print('EDGE_OCR=region')
    print(f'EDGE_OCR_MANIFEST={path.resolve()}')
    print('EDGE_OCR_MANIFEST_SHA256=' + hashlib.sha256(path.read_bytes()).hexdigest())
    print('EDGE_OCR_BATCH_SIZE=4')
    print('EDGE_OCR_THREADS=4')
    print('EDGE_OCR_DETECT_MAX_SIDE=960')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheel', required=True, type=Path)
    parser.add_argument('--english-recognizer', type=Path, help='Optional pinned English PP-OCRv4 ONNX model')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    provision(args.wheel, args.out, args.english_recognizer)


if __name__ == '__main__':
    main()
