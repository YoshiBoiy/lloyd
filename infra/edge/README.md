# RDK X5 gateway deployment (release contract v2)

Operational half of `Lloyd_Edge_Cloud_TDD_v2.md` §4 and §9. Everything here is enforced twice: in
the gateway code (origin allowlist, forwarded-request denial, signed approvals, digest-pinned
models) and at the host boundary (systemd sandboxing, nftables egress).

## Layout on the board

```
/opt/lloyd-edge/<version>/      read-only bundle: app/, models/, infra/, scripts/, venv/, bundle.manifest.json
/opt/lloyd-edge/current -> <version>
/etc/lloyd-edge/gateway.env     root:lloyd-edge 0600 (see lloyd-edge.env.example)
/etc/lloyd-edge/reviewers.json  root:lloyd-edge 0600 [{"token","id","key"}]
/var/lib/lloyd-edge/            lloyd-edge:lloyd-edge 0700 encrypted intake store
```

## Build a bundle (on a workstation)

```sh
npm run bundle:edge -- build --version 2.0.0 --out dist/edge-bundle \
  --model models/classifier.json --detector models/ner --wheelhouse wheelhouse/
npm run bundle:edge -- verify dist/edge-bundle/bundle.manifest.json
```

The manifest lists a SHA-256 for every file, the `pip freeze` lock, the model identities, and the
exact `EDGE_CLASSIFIER_SHA256` / `EDGE_DETECTOR_SHA256` values to put in `gateway.env`. The gateway
refuses to load a model whose digest differs, and `/health` reports the loaded identity. Nothing is
downloaded at runtime; the wheelhouse is installed offline with
`pip install --no-index --find-links wheelhouse -e app[vision]`.

## Install / upgrade

1. Copy the bundle to `/opt/lloyd-edge/<version>` (owned by root, world-readable, nothing writable).
2. Create the venv inside the bundle from the wheelhouse using the deployed Python 3.12; do not
   replace the system interpreter.
3. `useradd --system --no-create-home --shell /usr/sbin/nologin lloyd-edge` (first install only) and
   add it to `video`.
4. Fill `gateway.env` from `lloyd-edge.env.example`; generate distinct 32+ character device and
   reviewer keys. The device key, each reviewer key and the storage encryption key are separate
   secrets and must never appear in the repository, the web bundle, or provider logs.
5. Register the same device/reviewer bindings on the backend (`EDGE_V2_POLICY_FILE`).
6. Load `nftables-egress.conf` with the placeholders substituted; confirm the backend host is the
   only destination the `lloyd-edge` account can reach (`sudo -u lloyd-edge curl https://example.com`
   must fail).
7. `ln -sfn /opt/lloyd-edge/<version> /opt/lloyd-edge/current`, then
   `systemctl daemon-reload && systemctl restart lloyd-edge-gateway`.
   `ExecStartPre` verifies the manifest; a tampered install does not start.
8. Check `curl -H 'authorization: Bearer <EDGE_LOCAL_TOKEN>' http://<board>:8001/health`:
   every capability should be `ready`, `v2Enabled` reflects the per-device flag.

## Rollback

`ln -sfn /opt/lloyd-edge/<previous> /opt/lloyd-edge/current && systemctl restart lloyd-edge-gateway`.
The previous bundle is untouched by the upgrade (it is outside every writable path). A rolled-back
gateway reports its own capabilities honestly; it never bypasses v2 signature checks or releases
without approval, and v2 records already in the store stay readable and are never downgraded.

## Clock

`time-sync.target` is a start dependency and the gateway compares its clock with the backend `Date`
header before every release (`EDGE_CLOCK_TOLERANCE_SECONDS`). A skewed device is told to correct
UTC; historical audit timestamps are never rewritten.

## Logs

`journalctl -u lloyd-edge-gateway` contains intake IDs, bounded stage/status codes, policy and
model versions, and latencies. No page text, OCR, prompts or identifiers are logged; nftables
denials are rate-limited and carry only addresses.

### Page detector implementation status

The page-detector TDD contract and CPU mask-to-quad stages are implemented.
`/health.capabilities.pageDetector` is distinct from the semantic NER `detector`.
Unset, off, missing, invalid, or digest-mismatched artifacts retain classical page
finding. The explicit `EDGE_PAGE_DETECTOR_BACKEND=cpu` test backend accepts a PNG
mask at `EDGE_PAGE_DETECTOR_PATH` with its SHA-256 pin; health identifies it as
`cpu-mask-fixture`. It is for synthetic tests only. A ready detector abstaining
clears the preview after the existing six-frame tracker hold, while still capture
falls back to classical CV. Quality records include bounded detector metadata,
never masks; stored originals are unchanged.

Production BPU loading is not implemented or enabled yet: even a digest-valid
`.bin` reports `BPU_ARTIFACT_NOT_VALIDATED`. Continue at TDD step 2 with labeled
X5 training/validation images, then validate the one-class export before building
the runtime adapter and bundle support. Stock COCO weights cannot satisfy this
gate. No changes to the running board or API are required for CPU tests:

```sh
apps/edge-gateway/.venv/bin/python -m pytest apps/edge-gateway/tests -q
```

### Persistent text detection and OCR

`EDGE_OCR=region` selects a still-image pipeline with separate pretrained
PP-OCRv4 text detection and recognition models through ONNX Runtime. Detection
uses a working image capped at 960 pixels; detected polygons are mapped back to
the corrected full-resolution page before perspective cropping. Recognition
uses aspect-ratio-grouped batches (default 4). Both model sessions live for the
life of the gateway, with a lock protecting concurrent captures. OCR never runs
in the live-preview generator. Layout boxes and polygons remain in corrected-page
coordinates; original captures remain unchanged. Empty detection returns empty
OCR for the existing recapture policy, while model load/inference failures use
Tesseract and record a bounded fallback reason.

Models must be provisioned locally and SHA-256 pinned. Runtime does not download
weights. The OCR runtime is optional (`pyproject.toml` extra `ocr`); it uses neither
PyTorch nor Paddle. For a headless board, the existing `opencv-python-headless`
provides `cv2`; install the RapidOCR wheel with `--no-deps` after installing its
other requirements to avoid installing competing OpenCV wheels.

Provision from the official `rapidocr_onnxruntime-1.4.4-py3-none-any.whl`:

```sh
python3 scripts/provision-ocr-models.py \
  --wheel /absolute/path/rapidocr_onnxruntime-1.4.4-py3-none-any.whl \
  --english-recognizer /absolute/path/en_PP-OCRv4_rec_mobile.onnx \
  --out dist/ocr-models-en
python3 scripts/build-edge-bundle.py build --version ocr-v1 \
  --out dist/edge-bundle --ocr-models dist/ocr-models-en
python3 scripts/build-edge-bundle.py verify dist/edge-bundle/bundle.manifest.json
```

The provisioning script verifies the wheel SHA-256, extracts only detection and
recognition models, and records model licenses and digests. Set `EDGE_OCR=region`,
`EDGE_OCR_MANIFEST` to the installed `manifest.json`, and
`EDGE_OCR_MANIFEST_SHA256` to its digest. `EDGE_OCR_BATCH_SIZE`, `EDGE_OCR_THREADS`,
and `EDGE_OCR_DETECT_MAX_SIDE` default to 4, 4, and 960 (the X5-tested English
recognizer configuration). `/health.capabilities.ocr`
reports the actual CPU backend, runtime, model identities, pins, configuration,
and bounded errors. Per-capture OCR metrics contain detection/recognition/total
latency and region count, without image data or recognized text.

The optional existing `EDGE_OCR=paddle` adapter now also caches one pipeline and
sets its recognition batch size. Region mode is the deployable CPU path and has
independent digest pinning; it does not require Paddle's ARM runtime.

Verify actual model execution with generated non-sensitive text on the target:

```sh
python scripts/check-edge-ocr.py --app /opt/lloyd-edge-gateway \
  --manifest /opt/lloyd-ocr-models/v1-en/manifest.json
```

This check verifies recognition, coordinate bounds, persistent session identity,
and reports timings against Tesseract. It is a smoke test, not a claim of accuracy
or speed on photographed customer documents. On the X5, English recognition with
four threads and batches of four ran this generated page in about 2.8 s; Tesseract
was about 2.2 s on the same image. Keep Tesseract installed as the bounded
fallback. Page segmentation still requires its separate trained artifact. These
OCR models do not turn stock COCO weights into a page model or enable a combined
page/text model.

Rollback on the interim `/opt/lloyd-edge-gateway` board: overlays live in
`/root/lloyd-edge-rollback/ocr-2026-09-20/`. Restore Tesseract by applying
`tesseract.env.overlay`, removing
`/etc/systemd/system/lloyd-edge-gateway.service.d/ocr-runtime.conf`, then
`systemctl daemon-reload && systemctl restart lloyd-edge-gateway`. Restore the
tested English region config with `region.env.overlay` and the same drop-in.
Do not copy a full `gateway.env`; overlays contain only OCR keys. The previous
`.venv` and `/opt/lloyd-ocr-models/v1` stay unused while `EDGE_OCR=region`.
