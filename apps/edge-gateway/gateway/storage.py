import json
import os
import time
from pathlib import Path
from uuid import UUID
from cryptography.fernet import Fernet


class LocalStore:
    """Encrypted originals/token maps; audit manifests survive explicit original deletion."""

    def __init__(self, root: Path, retention_seconds: int = 86400):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        key_file = root / ".key"
        if not key_file.exists():
            fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(Fernet.generate_key())
        self.key = key_file.read_bytes()
        self.cipher = Fernet(self.key)
        self.retention_seconds = retention_seconds

    def path(self, document_id: str) -> Path:
        return self.root / (str(UUID(document_id)) + ".enc")

    def save(self, document_id: str, value: dict):
        target = self.path(document_id)
        temporary = target.with_suffix(".tmp")
        payload = self.cipher.encrypt(json.dumps(value).encode())
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
        temporary.replace(target)

    def load(self, document_id: str) -> dict:
        value = json.loads(self.cipher.decrypt(self.path(document_id).read_bytes()))
        if time.time() >= value["retentionUntil"]:
            self.delete_original(document_id, value)
        return value

    def delete_original(self, document_id: str, value: dict | None = None):
        if value is None:
            value = json.loads(self.cipher.decrypt(self.path(document_id).read_bytes()))
        for field in ["original", "ocr", "tokenMap"]:
            value.pop(field, None)
        value["originalDeleted"] = True
        self.save(document_id, value)
        return value

    def purge_expired(self):
        count = 0
        for path in self.root.glob("*.enc"):
            value = json.loads(self.cipher.decrypt(path.read_bytes()))
            if time.time() >= value["retentionUntil"] and not value.get("originalDeleted"):
                self.delete_original(path.stem, value)
                count += 1
        return count
