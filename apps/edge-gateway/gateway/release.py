"""The sole outbound module. No caller-supplied destination URLs or redirect following."""

import hashlib
import hmac
import json
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse
import httpx
from .contracts import Intake


def _check_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
        raise ValueError("Release destination must use HTTPS or local loopback")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Invalid destination URL")
    return url


class ReleaseClient:
    def __init__(self, url: str, token: str = "", approval_key: str = "", transport=None, v2_url: str | None = None):
        self.url = _check_url(url)
        # v2 defaults to the sibling route on the same backend origin.
        parsed = urlparse(self.url)
        self.v2_url = _check_url(v2_url or f"{parsed.scheme}://{parsed.netloc}/api/intake/v2")
        self.health_url = f"{parsed.scheme}://{parsed.netloc}/health"
        self.token, self.approval_key, self.transport = token, approval_key, transport

    def _headers(self):
        return {"Authorization": "Bearer " + self.token} if self.token else {}

    def send(self, payload: Intake):
        data = payload.model_dump(mode="json", exclude_none=True)
        if hashlib.sha256(payload.artifact.text.encode()).hexdigest() != payload.manifest.sanitizedSha256:
            raise ValueError("Sanitized hash mismatch")
        headers = self._headers()
        approval = data["manifest"].get("approval")
        if approval:
            if not self.approval_key:
                raise ValueError("Paired approval key required")
            m = data["manifest"]
            signed = json.dumps(
                [
                    m["documentId"],
                    m["caseId"],
                    m["sanitizedSha256"],
                    format(m["confidence"], ".6f"),
                    ",".join(sorted(m["destinations"])),
                    approval["approvedBy"],
                    approval["approvedAt"],
                ],
                separators=(",", ":"),
                ensure_ascii=False,
            )
            headers["x-release-approval"] = hmac.new(
                self.approval_key.encode(), signed.encode(), hashlib.sha256
            ).hexdigest()
        with httpx.Client(timeout=15, follow_redirects=False, transport=self.transport) as client:
            response = client.post(self.url, json=data, headers=headers)
            response.raise_for_status()
            return response.json()

    def send_v2(self, envelope: dict) -> dict:
        """Transmit an approved, already-signed v2 envelope exactly as validated. A 409 means the
        backend holds a different digest for this identity; a 2xx returns the durable receipt."""
        with httpx.Client(timeout=30, follow_redirects=False, transport=self.transport) as client:
            response = client.post(
                self.v2_url, content=json.dumps(envelope, allow_nan=False).encode(), headers={**self._headers(), "content-type": "application/json"}
            )
            if response.status_code == 409:
                raise ReleaseConflict(response.json().get("error", {}).get("code", "CONFLICT"))
            response.raise_for_status()
            return response.json()

    def server_time(self) -> datetime | None:
        """Backend wall-clock from the HTTP Date header; None when unreachable."""
        try:
            with httpx.Client(timeout=5, follow_redirects=False, transport=self.transport) as client:
                response = client.get(self.health_url, headers=self._headers())
            date = response.headers.get("date")
            return parsedate_to_datetime(date).astimezone(timezone.utc) if date else None
        except (httpx.HTTPError, TypeError, ValueError):
            return None


class ReleaseConflict(RuntimeError):
    """The backend already holds this (tenant, device, intake, revision) with a different digest."""
