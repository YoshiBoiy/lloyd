import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalV2,
  signV2,
  verifyV2,
  type IntakeV2,
  type V2Policy,
} from "../packages/contracts/src/intake-v2.js";
import { DomainError } from "../packages/contracts/src/index.js";

const golden = JSON.parse(
  readFileSync(
    new URL(
      "../packages/contracts/fixtures/intake-v2.golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { now: string; policy: V2Policy; envelope: IntakeV2 };

function policy(overrides: Partial<V2Policy> = {}): V2Policy {
  return {
    ...structuredClone(golden.policy),
    now: Date.parse(golden.now),
    ...overrides,
  };
}
function envelope(mutate?: (e: IntakeV2) => void): IntakeV2 {
  const e = structuredClone(golden.envelope);
  mutate?.(e);
  return e;
}
function resign(e: IntakeV2): IntakeV2 {
  e.authentication.signature = signV2(
    e.manifest,
    golden.policy.devices["golden-key-1"]!.key,
  );
  e.authentication.reviewerSignature = signV2(
    e.manifest,
    golden.policy.reviewers["reviewer-golden"]!.key,
    "reviewer",
  );
  return e;
}
function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    return (error as Error).constructor.name;
  }
  return "OK";
}

describe("intake v2 cross-language contract", () => {
  it("accepts the Python-generated golden envelope byte for byte", () => {
    const result = verifyV2(golden.envelope, policy());
    expect(result.data.manifest.revision).toBe(3);
    expect(result.identity).toMatch(/^[a-f0-9]{64}$/);
    // Signatures were produced by Python rfc8785 + HMAC; TypeScript must derive identical values.
    expect(
      signV2(
        golden.envelope.manifest,
        golden.policy.devices["golden-key-1"]!.key,
      ),
    ).toBe(golden.envelope.authentication.signature);
    expect(
      signV2(
        golden.envelope.manifest,
        golden.policy.reviewers["reviewer-golden"]!.key,
        "reviewer",
      ),
    ).toBe(golden.envelope.authentication.reviewerSignature);
  });

  it("canonicalizes numbers and unicode per RFC 8785 and rejects invalid values", () => {
    expect(canonicalV2({ b: 1e-7, a: "caf\u00e9", c: [1.5, 0.05] })).toBe(
      '{"a":"café","b":1e-7,"c":[1.5,0.05]}',
    );
    expect(code(() => canonicalV2({ x: Number.NaN }))).toBe(
      "INVALID_CANONICAL_VALUE",
    );
    expect(code(() => canonicalV2({ x: "\uD800" }))).toBe(
      "INVALID_CANONICAL_VALUE",
    );
  });

  it("rejects tampered, unapproved, expired, changed-revision, bad-signature and wrong-tenant releases", () => {
    expect(
      code(() =>
        verifyV2(
          envelope((e) => (e.artifacts[2]!.text = "Year built: 2017")),
          policy(),
        ),
      ),
    ).toBe("ARTIFACT_MISMATCH");
    expect(
      code(() =>
        verifyV2(
          envelope((e) => (e.manifest.revision = 4)),
          policy(),
        ),
      ),
    ).toBe("BAD_SIGNATURE");
    expect(
      code(() =>
        verifyV2(
          envelope((e) => (e.manifest.caseId = "case-x")),
          policy(),
        ),
      ),
    ).toBe("BAD_SIGNATURE");
    expect(
      code(() =>
        verifyV2(
          envelope((e) => (e.authentication.signature = "0".repeat(64))),
          policy(),
        ),
      ),
    ).toBe("BAD_SIGNATURE");
    expect(
      code(() =>
        verifyV2(
          envelope(
            (e) => (e.authentication.reviewerSignature = "0".repeat(64)),
          ),
          policy(),
        ),
      ),
    ).toBe("BAD_SIGNATURE");
    expect(
      code(() =>
        verifyV2(
          envelope((e) => (e.manifest.tenantId = "tenant-other")),
          policy(),
        ),
      ),
    ).toBe("DEVICE_DENIED");
    expect(
      code(() =>
        verifyV2(
          envelope((e) => (e.authentication.keyId = "unknown-key")),
          policy(),
        ),
      ),
    ).toBe("DEVICE_DENIED");
    expect(
      code(() =>
        verifyV2(
          golden.envelope,
          policy({ now: Date.parse("2026-09-19T12:16:00.000Z") }),
        ),
      ),
    ).toBe("APPROVAL_EXPIRED_OR_CLOCK_INVALID");
    expect(
      code(() =>
        verifyV2(
          golden.envelope,
          policy({ now: Date.parse("2026-09-19T11:00:00.000Z") }),
        ),
      ),
    ).toBe("APPROVAL_EXPIRED_OR_CLOCK_INVALID");
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope(
              (e) =>
                (e.manifest.approval.expiresAt = "2026-09-19T13:05:00.000Z"),
            ),
          ),
          policy(),
        ),
      ),
    ).toBe("APPROVAL_EXPIRED_OR_CLOCK_INVALID");
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope((e) => (e.manifest.approval.acknowledgedQuality = false)),
          ),
          policy(),
        ),
      ),
    ).toBe("QUALITY_BLOCKED");
    expect(
      code(() =>
        verifyV2(
          resign(envelope((e) => (e.manifest.quality.status = "RECAPTURE"))),
          policy(),
        ),
      ),
    ).toBe("QUALITY_BLOCKED");
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope((e) => {
              e.manifest.classification.status = "UNAVAILABLE";
            }),
          ),
          policy(),
        ),
      ),
    ).toBe("MODEL_UNAVAILABLE");
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope(
              (e) => (e.manifest.destinations = ["lloyd-api", "openai"]),
            ),
          ),
          policy(),
        ),
      ),
    ).toBe("DESTINATION_DENIED");
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope((e) => (e.manifest.matchHints.documentType = "loss_run")),
          ),
          policy(),
        ),
      ),
    ).toBe("CLASSIFICATION_MISMATCH");
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope(
              (e) => (e.manifest.classification.evidenceIds = ["p9_line_9"]),
            ),
          ),
          policy(),
        ),
      ),
    ).toBe("INVALID_PROVENANCE");
    expect(
      code(() =>
        verifyV2(
          resign(envelope((e) => (e.manifest.quality.pageCount = 1))),
          policy(),
        ),
      ),
    ).toBe("PAGE_MISMATCH");
  });

  it("rejects reviewers outside the tenant or without access to a preselected case", () => {
    const scoped = policy();
    scoped.reviewers["reviewer-golden"]!.caseIds = ["case-allowed"];
    expect(
      code(() =>
        verifyV2(
          resign(envelope((e) => (e.manifest.caseId = "case-denied"))),
          scoped,
        ),
      ),
    ).toBe("REVIEWER_DENIED");
    expect(
      code(() =>
        verifyV2(
          resign(envelope((e) => (e.manifest.caseId = "case-allowed"))),
          scoped,
        ),
      ),
    ).toBe("OK");
    const foreign = policy();
    foreign.reviewers["reviewer-golden"]!.tenantId = "tenant-other";
    expect(code(() => verifyV2(golden.envelope, foreign))).toBe(
      "REVIEWER_DENIED",
    );
  });

  it("rejects sensitive content within and across block boundaries, undeclared bytes and unknown fields", () => {
    const setText = (e: IntakeV2, index: number, text: string) => {
      e.artifacts[index]!.text = text;
      e.manifest.artifacts[index]!.byteLength = Buffer.byteLength(text);
      e.manifest.artifacts[index]!.sha256 = createHash("sha256")
        .update(text)
        .digest("hex");
    };
    expect(
      code(() =>
        verifyV2(
          resign(envelope((e) => setText(e, 0, "Contact: Jane Canary"))),
          policy(),
        ),
      ),
    ).toBe("SENSITIVE_CONTENT");
    // A phone number split across two blocks is caught by the cross-block scan.
    expect(
      code(() =>
        verifyV2(
          resign(
            envelope((e) => {
              setText(e, 0, "Call 416-555-");
              setText(e, 1, "0188 today");
            }),
          ),
          policy(),
        ),
      ),
    ).toBe("SENSITIVE_CONTENT");
    expect(
      code(() =>
        verifyV2(
          envelope((e) =>
            e.artifacts.push({
              id: "extra",
              mediaType: "text/plain",
              text: "undeclared",
            }),
          ),
          policy(),
        ),
      ),
    ).toBe("ARTIFACT_MISMATCH");
    expect(
      code(() => verifyV2({ ...envelope(), tokenMap: { a: "b" } }, policy())),
    ).toBe("ZodError");
    expect(
      code(() =>
        verifyV2(
          envelope(
            (e) => ((e.manifest as Record<string, unknown>).rawText = "x"),
          ),
          policy(),
        ),
      ),
    ).toBe("ZodError");
  });

  it("binds identity to the digest so a changed revision yields a different identity", () => {
    const first = verifyV2(golden.envelope, policy());
    const second = verifyV2(
      resign(envelope((e) => (e.manifest.revision = 4))),
      policy(),
    );
    expect(first.identity).not.toBe(second.identity);
    expect(first.digest).not.toBe(second.digest);
  });
});
