#!/usr/bin/env python3
"""Exercise real OCR models using generated, non-sensitive text; no camera access."""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path(__file__).resolve().parents[1] / 'apps/edge-gateway')
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.app.resolve()))
    import cv2
    import numpy as np
    from gateway.capture import LocalOCR
    from gateway.ocr_runtime import RegionOCR

    loaded = time.perf_counter()
    ocr = RegionOCR(str(args.manifest), hashlib.sha256(args.manifest.read_bytes()).hexdigest())
    report = {'capabilities': ocr.capabilities(), 'loadMs': round((time.perf_counter() - loaded) * 1000), 'runs': []}
    if not ocr.available():
        raise SystemExit(json.dumps(report))
    engines = ocr.engines
    frame = np.full((1600, 1200, 3), 255, np.uint8)
    lines = ['LLOYD INSURANCE REVIEW', 'Policy Number ABC12345', 'Year built: 2016',
             'Construction: Masonry', 'Building area: 24000 sqft', 'Sprinklered: Yes',
             'Total insured value: 2500000', 'Loss history: No claims']
    for i, line in enumerate(lines):
        cv2.putText(frame, line, (65, 140 + 110 * i), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 2, cv2.LINE_AA)
    content = cv2.imencode('.png', frame)[1].tobytes()
    for _ in range(args.runs):
        result = ocr.extract(content, 'image/png')
        ok = result.adapter == 'ppocr-onnx-cpu' and all(word in result.text for word in ['2016', 'Masonry', '24000'])
        boxes_ok = all(0 <= line['box'][0] < 1200 and 0 <= line['box'][1] < 1600
                       and line['box'][0] + line['box'][2] <= 1200
                       and line['box'][1] + line['box'][3] <= 1600 for line in result.lines)
        report['runs'].append({'passed': ok and boxes_ok, 'lines': len(result.lines),
                               'confidence': round(result.confidence, 4), **result.metrics})
        assert ocr.engines is engines, 'Models were recreated'
    start = time.perf_counter()
    baseline = LocalOCR().extract(content, 'image/png')
    report['tesseract'] = {'latencyMs': round((time.perf_counter() - start) * 1000),
                           'adapter': baseline.adapter, 'lines': len(baseline.lines),
                           'confidence': round(baseline.confidence, 4)}
    report['passed'] = all(run['passed'] for run in report['runs'])
    body = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(body + '\n')
    print(body)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
