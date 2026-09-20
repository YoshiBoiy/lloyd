import json
import os
import time
import tempfile
from pathlib import Path
from uuid import UUID
from cryptography.fernet import Fernet

INDEX_NAME = "index.enc"


class LocalStore:
    """Encrypted originals/token maps; audit manifests survive explicit original deletion.

    Alongside the per-record files the store keeps one encrypted enumeration index
    (`index.enc`) holding a bounded metadata row per record, so v2 intakes can be listed
    without decrypting every record. The index is never a second source of truth: rows are
    written inside the caller's lock on every save, repaired against the record on read, and
    rebuilt from the record files if the index is missing or undecryptable.
    """

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
        self.index_rebuilds = 0

    def path(self, document_id: str) -> Path:
        return self.root / (str(UUID(document_id)) + ".enc")

    @property
    def index_path(self) -> Path:
        return self.root / INDEX_NAME

    def _write(self, target: Path, payload: bytes) -> None:
        fd, name = tempfile.mkstemp(prefix="encrypted-", suffix=".tmp", dir=self.root)
        temporary = Path(name)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
        fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def save(self, document_id: str, value: dict, index_row: dict | None = None):
        self._write(self.path(document_id), self.cipher.encrypt(json.dumps(value).encode()))
        if index_row is not None:
            self.index_put(document_id, index_row)

    def load(self, document_id: str) -> dict:
        value = json.loads(self.cipher.decrypt(self.path(document_id).read_bytes()))
        if time.time() >= value["retentionUntil"]:
            self.delete_original(document_id, value)
        return value

    def delete_original(self, document_id: str, value: dict | None = None):
        if value is None:
            value = json.loads(self.cipher.decrypt(self.path(document_id).read_bytes()))
        for field in ["original", "corrected", "ocr", "tokenMap", "pages", "localModelOutput", "rawDetections"]:
            value.pop(field, None)
        value["originalDeleted"] = True
        self.save(document_id, value)
        # Retention must not leave the index advertising a reviewable intake.
        self.index_patch(document_id, {"originalDeleted": True, "stage": "ORIGINAL_EXPIRED"})
        return value

    def purge_expired(self):
        count = 0
        for path in self.root.glob("*.enc"):
            if path.name == INDEX_NAME:
                continue
            value = json.loads(self.cipher.decrypt(path.read_bytes()))
            if time.time() >= value["retentionUntil"] and not value.get("originalDeleted"):
                self.delete_original(path.stem, value)
                count += 1
        return count

    # --- enumeration index ------------------------------------------------------------

    def records(self):
        """Every stored record, decrypting each file. Used to rebuild the index."""
        for path in sorted(self.root.glob("*.enc")):
            if path.name == INDEX_NAME:
                continue
            try:
                yield path.stem, json.loads(self.cipher.decrypt(path.read_bytes()))
            except Exception:  # noqa: BLE001 - an unreadable record must not stop enumeration
                continue

    def _read_index(self) -> dict[str, dict] | None:
        if not self.index_path.exists():
            return None
        try:
            rows = json.loads(self.cipher.decrypt(self.index_path.read_bytes()))
        except Exception:  # noqa: BLE001 - undecryptable or truncated index is rebuilt
            return None
        return rows if isinstance(rows, dict) else None

    def _write_index(self, rows: dict[str, dict]) -> None:
        self._write(self.index_path, self.cipher.encrypt(json.dumps(rows).encode()))

    def index_put(self, document_id: str, row: dict) -> None:
        rows = self._read_index() or {}
        rows[str(UUID(document_id))] = row
        self._write_index(rows)

    def index_patch(self, document_id: str, changes: dict) -> None:
        rows = self._read_index()
        key = str(UUID(document_id))
        if not rows or key not in rows:
            return
        rows[key] = {**rows[key], **changes}
        self._write_index(rows)

    def index_drop(self, document_id: str) -> None:
        rows = self._read_index()
        key = str(UUID(document_id))
        if rows and key in rows:
            del rows[key]
            self._write_index(rows)

    def rebuild_index(self, summarize) -> dict[str, dict]:
        """Reconstruct the index by globbing record files, exactly as `purge_expired` does."""
        rows: dict[str, dict] = {}
        for document_id, record in self.records():
            row = summarize(record)
            if row is not None:
                rows[document_id] = row
        self._write_index(rows)
        self.index_rebuilds += 1
        return rows

    def index_all(self, summarize) -> list[dict]:
        """Index rows, repaired against the records. `summarize(record)` returns a row or None.

        A row whose record is gone is dropped; a row that disagrees with its record is
        replaced by the record's own summary. The record is always authoritative.
        """
        rows = self._read_index()
        if rows is None:
            rows = self.rebuild_index(summarize)
        repaired: dict[str, dict] = {}
        dirty = False
        for document_id, row in rows.items():
            try:
                record = json.loads(self.cipher.decrypt(self.path(document_id).read_bytes()))
            except Exception:  # noqa: BLE001 - absent or unreadable record drops the row
                dirty = True
                continue
            current = summarize(record)
            if current is None:
                dirty = True
                continue
            if current != row:
                dirty = True
            repaired[document_id] = current
        if dirty:
            self._write_index(repaired)
        return list(repaired.values())

    def index_count(self) -> int:
        return len(self._read_index() or {})
