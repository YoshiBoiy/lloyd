"""The sole outbound module. No caller-supplied destination URLs or redirect following."""

import hashlib
import hmac
import json
from urllib.parse import urlparse
import httpx
from .contracts import Intake


class ReleaseClient:
    def __init__(self, url: str, token: str = "", approval_key: str = "", transport=None):
        parsed = urlparse(url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
            raise ValueError("Release destination must use HTTPS or local loopback")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Invalid destination URL")
        self.url, self.token, self.approval_key, self.transport = url, token, approval_key, transport

    def send(self, payload: Intake):
        data = payload.model_dump(mode="json", exclude_none=True)
        if hashlib.sha256(payload.artifact.text.encode()).hexdigest() != payload.manifest.sanitizedSha256:
            raise ValueError("Sanitized hash mismatch")
        headers = {"Authorization": "Bearer " + self.token} if self.token else {}
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
