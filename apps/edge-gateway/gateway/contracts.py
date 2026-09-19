from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field

Destination = Literal["lloyd-api", "gemini", "openai", "gptzero", "elasticsearch"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PrivacyField(Strict):
    path: str = Field(min_length=1, max_length=200)
    classification: Literal["local_only", "redacted", "tokenized", "generalized", "cloud_allowed"]
    method: str | None = None
    confidence: float = Field(ge=0, le=1)


class Approval(Strict):
    approvedBy: str = Field(min_length=1, max_length=100)
    approvedAt: datetime


class Manifest(Strict):
    version: Literal[1] = 1
    documentId: UUID
    caseId: str = Field(min_length=1, max_length=100)
    sanitizedSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    fields: list[PrivacyField]
    destinations: list[Destination] = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)
    approval: Approval | None = None
    createdAt: datetime


class Artifact(Strict):
    mediaType: Literal["text/plain"] = "text/plain"
    text: str = Field(max_length=2_000_000)


class Intake(Strict):
    manifest: Manifest
    artifact: Artifact
