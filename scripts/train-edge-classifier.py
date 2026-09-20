"""Train the offline edge classifier from consented JSONL {text,label}; evaluate on a separate held-out set.

    python scripts/train-edge-classifier.py corpus.jsonl model.json --threshold 0.7 --min-coverage 0.3 [--evaluate heldout.jsonl]

Prints the artifact SHA-256 to pin as EDGE_CLASSIFIER_SHA256. Never downloads anything.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "edge-gateway"))
from gateway.inference import LocalClassifier
from gateway.train import evaluate, train, write_model


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


parser = argparse.ArgumentParser()
parser.add_argument("corpus", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--threshold", type=float, required=True)
parser.add_argument("--min-coverage", type=float, required=True)
parser.add_argument("--model-id", default="local-text-v1")
parser.add_argument("--evaluate", type=Path, help="Frozen held-out JSONL; label `unknown` rows measure OOD rejection")
args = parser.parse_args()

digest = write_model(train(rows(args.corpus), model_id=args.model_id, threshold=args.threshold, min_coverage=args.min_coverage), args.output)
print(digest)
if args.evaluate:
    report = evaluate(LocalClassifier(str(args.output), digest), rows(args.evaluate))
    print(json.dumps(report, indent=2))
