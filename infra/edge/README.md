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
