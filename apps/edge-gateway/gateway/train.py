"""Offline training and evaluation for the local document classifier.

Training data are consented/synthetic JSONL rows `{"text": ..., "label": ...}`.
Evaluation data must be a separately frozen held-out set (TDD v2 §10); the
`evaluate` helper reports macro-F1, unknown-rejection recall, coverage and a
confusion matrix rather than accuracy alone.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path

LABELS = sorted(["inspection_report", "loss_run", "statement_of_values", "application", "policy_document", "correspondence", "mixed"])
TOKEN = re.compile(r"\b\w+\b")


def tokenize(text: str) -> list[str]:
    return TOKEN.findall(text.lower())


def train(rows: list[dict], *, model_id: str = "local-text-v1", threshold: float, min_coverage: float) -> dict:
    if not 0 < threshold <= 1 or not 0 < min_coverage <= 1:
        raise ValueError("Invalid abstention policy")
    counts = {label: Counter() for label in LABELS}
    documents: Counter = Counter()
    for row in rows:
        if row["label"] not in LABELS:
            raise ValueError("Invalid training label")
        counts[row["label"]].update(tokenize(row["text"]))
        documents[row["label"]] += 1
    if any(documents[label] == 0 for label in LABELS):
        raise ValueError("All known classes require training examples")
    vocabulary = sorted(set().union(*(set(c) for c in counts.values())))
    totals = {label: sum(counts[label].values()) + len(vocabulary) for label in LABELS}
    return {
        "format": "lloyd-multinomial-v1",
        "modelId": model_id,
        "labels": LABELS,
        "threshold": threshold,
        "minCoverage": min_coverage,
        "calibration": "UNCALIBRATED",
        "trainingDocuments": dict(documents),
        "priors": [math.log(documents[label] / sum(documents.values())) for label in LABELS],
        "weights": {word: [math.log((counts[label][word] + 1) / totals[label]) for label in LABELS] for word in vocabulary},
    }


def write_model(model: dict, output: Path) -> str:
    output.write_text(json.dumps(model, allow_nan=False))
    return hashlib.sha256(output.read_bytes()).hexdigest()


def evaluate(classifier, rows: list[dict]) -> dict:
    """Held-out evaluation. Rows with label `unknown` measure out-of-distribution rejection."""
    confusion: dict[str, Counter] = {}
    for row in rows:
        predicted = classifier.classify(row["text"], [])
        label = predicted["documentType"] if predicted["status"] == "CLASSIFIED" else "unknown"
        confusion.setdefault(row["label"], Counter())[label] += 1
    f1s = []
    for label in LABELS:
        tp = confusion.get(label, Counter())[label]
        fp = sum(c[label] for truth, c in confusion.items() if truth != label)
        fn = sum(v for pred, v in confusion.get(label, Counter()).items() if pred != label)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1s.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)
    unknown = confusion.get("unknown", Counter())
    known_rows = [r for r in rows if r["label"] in LABELS]
    covered = sum(v for truth, c in confusion.items() if truth in LABELS for pred, v in c.items() if pred != "unknown")
    return {
        "macroF1": sum(f1s) / len(f1s),
        "unknownRejectionRecall": unknown["unknown"] / sum(unknown.values()) if unknown else None,
        "coverage": covered / len(known_rows) if known_rows else None,
        "denominators": {"known": len(known_rows), "unknown": sum(unknown.values())},
        "confusion": {truth: dict(c) for truth, c in confusion.items()},
    }
