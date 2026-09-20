"""Build or verify a versioned edge bundle manifest (TDD §9).

A bundle is the gateway application plus the pinned local model artifacts. The manifest records a
SHA-256 for every file, the dependency lock, the license files and the model identities the
gateway will report in /health, so an installed board can be verified offline and rolled back to a
prior bundle by digest. No file in the bundle is ever fetched at runtime.

Usage:
  build-edge-bundle.py build --version 2.0.0 --out dist/edge-bundle \
      [--model path/to/classifier.json] [--detector path/to/spacy-model-dir] [--wheelhouse dir]
  build-edge-bundle.py verify dist/edge-bundle/bundle.manifest.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATEWAY = ROOT / "apps" / "edge-gateway"
MANIFEST_VERSION = 1


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_digest(root: Path) -> str:
    """Identical to gateway.inference.SemanticDetector._load: sorted relpath + NUL + raw file digest."""
    files = sorted(p for p in root.rglob("*") if p.is_file())
    return hashlib.sha256(
        b"".join(str(p.relative_to(root)).encode() + b"\0" + hashlib.sha256(p.read_bytes()).digest() for p in files)
    ).hexdigest()


def artifact_digest(target: Path) -> str:
    """Digest exactly as the gateway pins it: directory digest for spaCy models, file digest otherwise."""
    return directory_digest(target) if target.is_dir() else sha256_file(target)


def iter_files(base: Path):
    for path in sorted(base.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and not path.name.endswith((".pyc", ".pyo")):
            yield path


def copy_tree(source: Path, target: Path, entries: list[dict], kind: str) -> None:
    for path in iter_files(source):
        rel = path.relative_to(source)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        entries.append({"path": str(Path(kind) / rel), "sha256": sha256_file(dest), "bytes": dest.stat().st_size})


def freeze_lock(out: Path) -> str | None:
    """Record the exact installed dependency set from the gateway virtualenv, if present."""
    python = GATEWAY / ".venv" / "bin" / "python"
    if not python.exists():
        return None
    result = subprocess.run([str(python), "-m", "pip", "freeze", "--all"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return None
    lock = out / "requirements.lock"
    lock.write_text(result.stdout)
    return sha256_file(lock)


def build(args: argparse.Namespace) -> int:
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    entries: list[dict] = []
    copy_tree(GATEWAY / "gateway", out / "app" / "gateway", entries, "app/gateway")
    for name in ("pyproject.toml",):
        shutil.copy2(GATEWAY / name, out / "app" / name)
        entries.append({"path": f"app/{name}", "sha256": sha256_file(out / "app" / name), "bytes": (out / "app" / name).stat().st_size})
    for unit in (ROOT / "infra" / "edge").glob("*"):
        if unit.is_file():
            (out / "infra").mkdir(exist_ok=True)
            shutil.copy2(unit, out / "infra" / unit.name)
            entries.append({"path": f"infra/{unit.name}", "sha256": sha256_file(out / "infra" / unit.name), "bytes": unit.stat().st_size})
    models: dict[str, dict] = {}
    if args.model:
        model = Path(args.model)
        (out / "models").mkdir(exist_ok=True)
        shutil.copy2(model, out / "models" / model.name)
        digest = sha256_file(out / "models" / model.name)
        meta = json.loads(model.read_text())
        models["classifier"] = {
            "path": f"models/{model.name}",
            "sha256": digest,
            "modelId": meta.get("modelId"),
            "labels": meta.get("labels"),
            "threshold": meta.get("threshold"),
            "license": meta.get("license", "project-internal"),
            "env": {"EDGE_CLASSIFIER_PATH": f"models/{model.name}", "EDGE_CLASSIFIER_SHA256": digest},
        }
        entries.append({"path": f"models/{model.name}", "sha256": digest, "bytes": (out / "models" / model.name).stat().st_size})
    if args.detector:
        detector = Path(args.detector)
        target = out / "models" / detector.name
        target.parent.mkdir(exist_ok=True)
        if detector.is_dir():
            shutil.copytree(detector, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for path in iter_files(target):
                entries.append({"path": str(Path("models") / detector.name / path.relative_to(target)), "sha256": sha256_file(path), "bytes": path.stat().st_size})
            digest = directory_digest(target)
        else:
            shutil.copy2(detector, target)
            digest = sha256_file(target)
            entries.append({"path": f"models/{detector.name}", "sha256": digest, "bytes": target.stat().st_size})
        meta_path = target / "meta.json" if target.is_dir() else None
        meta = json.loads(meta_path.read_text()) if meta_path and meta_path.exists() else {}
        models["detector"] = {
            "path": f"models/{detector.name}",
            "sha256": digest,
            "modelId": meta.get("name"),
            "version": meta.get("version"),
            "license": meta.get("license", "unknown"),
            "env": {"EDGE_DETECTOR_PATH": f"models/{detector.name}", "EDGE_DETECTOR_SHA256": digest},
        }
    if getattr(args, "ocr_models", None):
        source = Path(args.ocr_models).resolve()
        metadata = json.loads((source / "manifest.json").read_bytes())
        if metadata.get("format") != "lloyd-ocr-v1":
            raise ValueError("Invalid OCR manifest")
        selected = {"manifest.json", "LICENSE", "NOTICE"}
        for role in ("textDetection", "textRecognition"):
            entry = metadata["models"][role]
            path = (source / entry["path"]).resolve()
            if not path.is_relative_to(source) or not entry.get("license") or sha256_file(path) != entry["sha256"]:
                raise ValueError("Invalid OCR model pin or license")
            selected.add(entry["path"])
        target = out / "models" / "ocr"
        for name in sorted(selected):
            source_file = source / name
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, destination)
            entries.append({"path": str(destination.relative_to(out)), "sha256": sha256_file(destination), "bytes": destination.stat().st_size})
        models["ocr"] = {
            "path": "models/ocr", "sha256": directory_digest(target),
            "modelId": "ppocr-v4-det-rec", "license": "Apache-2.0", "runtime": metadata["runtime"],
            "env": {
                "EDGE_OCR": "region",
                "EDGE_OCR_MANIFEST": "models/ocr/manifest.json",
                "EDGE_OCR_MANIFEST_SHA256": sha256_file(target / "manifest.json"),
                "EDGE_OCR_BATCH_SIZE": "4",
                "EDGE_OCR_THREADS": "4",
                "EDGE_OCR_DETECT_MAX_SIDE": "960",
            },
        }
    if args.wheelhouse:
        copy_tree(Path(args.wheelhouse), out / "wheelhouse", entries, "wheelhouse")
    licenses_dir = ROOT / "LICENSES"
    if licenses_dir.exists():
        copy_tree(licenses_dir, out / "licenses", entries, "licenses")
    lock_digest = freeze_lock(out)
    if lock_digest:
        entries.append({"path": "requirements.lock", "sha256": lock_digest, "bytes": (out / "requirements.lock").stat().st_size})
    git = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    manifest = {
        "manifestVersion": MANIFEST_VERSION,
        "bundle": "lloyd-edge-gateway",
        "version": args.version,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sourceCommit": git.stdout.strip() or None,
        "python": {"required": ">=3.11", "note": "Use the deployed interpreter; never replace the system Python (TDD §9)."},
        "runtimeDownloads": False,
        "models": models,
        "files": sorted(entries, key=lambda e: e["path"]),
    }
    body = json.dumps(manifest, indent=2, sort_keys=True).encode()
    (out / "bundle.manifest.json").write_bytes(body)
    (out / "bundle.manifest.json.sha256").write_text(hashlib.sha256(body).hexdigest() + "\n")
    print(f"built {out} ({len(entries)} files, bundle sha256 {hashlib.sha256(body).hexdigest()[:16]}…)")
    if not models:
        print("warning: no model artifacts included; /health will report classifier/detector unavailable", file=sys.stderr)
    return 0


def verify(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).resolve()
    base = manifest_path.parent
    manifest = json.loads(manifest_path.read_bytes())
    recorded = (base / "bundle.manifest.json.sha256").read_text().strip() if (base / "bundle.manifest.json.sha256").exists() else None
    problems: list[str] = []
    if recorded and recorded != hashlib.sha256(manifest_path.read_bytes()).hexdigest():
        problems.append("bundle.manifest.json digest mismatch")
    listed = {entry["path"] for entry in manifest["files"]}
    for entry in manifest["files"]:
        path = base / entry["path"]
        if not path.exists():
            problems.append(f"missing {entry['path']}")
        elif sha256_file(path) != entry["sha256"]:
            problems.append(f"digest mismatch {entry['path']}")
    for path in iter_files(base):
        rel = str(path.relative_to(base))
        if rel not in listed and rel not in {"bundle.manifest.json", "bundle.manifest.json.sha256"}:
            problems.append(f"unlisted file {rel}")
    for kind, model in manifest.get("models", {}).items():
        target = base / model["path"]
        if not target.exists():
            problems.append(f"{kind} artifact missing")
        elif artifact_digest(target) != model["sha256"]:
            problems.append(f"{kind} artifact digest mismatch")
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print(f"OK {manifest['bundle']} {manifest['version']} ({len(listed)} files verified)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    b.add_argument("--version", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--model", help="classifier JSON artifact from scripts/train-edge-classifier.py")
    b.add_argument("--detector", help="semantic detector artifact (spaCy model directory)")
    b.add_argument("--ocr-models", help="pinned OCR directory from provision-ocr-models.py")
    b.add_argument("--wheelhouse", help="directory of pre-downloaded wheels for offline install")
    b.set_defaults(func=build)
    v = sub.add_parser("verify")
    v.add_argument("manifest")
    v.set_defaults(func=verify)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
