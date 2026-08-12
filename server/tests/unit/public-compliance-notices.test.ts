import { describe, expect, it } from "vitest";
import {
  PUBLIC_COMPLIANCE_NOTICE_LIMITS,
  projectPublicComplianceNotices,
  toPublicComplianceNotice,
} from "../../src/routes/public-compliance-notices.js";

const validNotice = {
  severity: "future_custom_severity",
  code: "future_custom_code",
  message: "Update this capability before the next release.",
};

describe("public compliance notice projection", () => {
  it("preserves unknown code/severity values and allowlisted protocol fields only", () => {
    const raw = {
      ...validNotice,
      effective_version: "4.0",
      requirement: "request_signing",
      capability_path: "request_signing.supported",
      capability_pointer: "/request_signing/supported",
      reference_url: "https://example.com/docs?version=4#request-signing",
      docs_url: "https://private.example/docs",
      storyboard_ids: ["signed_requests"],
      experimental_context: { internal: true },
    };

    expect(toPublicComplianceNotice(raw)).toEqual({
      severity: "future_custom_severity",
      code: "future_custom_code",
      message: "Update this capability before the next release.",
      effective_version: "4.0",
      requirement: "request_signing",
      capability_path: "request_signing.supported",
      capability_pointer: "/request_signing/supported",
      reference_url: "https://example.com/docs?version=4#request-signing",
    });
    expect(raw).toHaveProperty("experimental_context");
  });

  it("drops malformed notices and oversized machine identifiers without coercion", () => {
    expect(toPublicComplianceNotice(null)).toBeNull();
    expect(toPublicComplianceNotice([])).toBeNull();
    expect(toPublicComplianceNotice({ ...validNotice, code: 123 })).toBeNull();
    expect(
      toPublicComplianceNotice({ ...validNotice, severity: "   " })
    ).toBeNull();
    expect(
      toPublicComplianceNotice({ ...validNotice, message: "" })
    ).toBeNull();
    expect(
      toPublicComplianceNotice({
        ...validNotice,
        code: "c".repeat(PUBLIC_COMPLIANCE_NOTICE_LIMITS.code + 1),
      })
    ).toBeNull();
    expect(
      toPublicComplianceNotice({
        ...validNotice,
        severity: "s".repeat(PUBLIC_COMPLIANCE_NOTICE_LIMITS.severity + 1),
      })
    ).toBeNull();
  });

  it("bounds display strings without splitting a surrogate pair", () => {
    const projected = toPublicComplianceNotice({
      ...validNotice,
      message: "😀".repeat(PUBLIC_COMPLIANCE_NOTICE_LIMITS.message),
      requirement: "r".repeat(PUBLIC_COMPLIANCE_NOTICE_LIMITS.requirement + 20),
      capability_path: "p".repeat(
        PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPath + 20
      ),
      capability_pointer: `/${"x".repeat(
        PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPointer + 20
      )}`,
      effective_version: "v".repeat(
        PUBLIC_COMPLIANCE_NOTICE_LIMITS.effectiveVersion + 20
      ),
    });

    expect(projected).not.toBeNull();
    expect(projected!.message.length).toBeLessThanOrEqual(
      PUBLIC_COMPLIANCE_NOTICE_LIMITS.message
    );
    expect(projected!.message).toMatch(/…$/);
    expect(projected!.message).not.toContain("\uFFFD");
    expect(projected!.requirement).toHaveLength(
      PUBLIC_COMPLIANCE_NOTICE_LIMITS.requirement
    );
    expect(projected!.capability_path).toHaveLength(
      PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPath
    );
    expect(projected!.capability_pointer).toHaveLength(
      PUBLIC_COMPLIANCE_NOTICE_LIMITS.capabilityPointer
    );
    expect(projected!.effective_version).toHaveLength(
      PUBLIC_COMPLIANCE_NOTICE_LIMITS.effectiveVersion
    );
  });

  it("does not scan beyond the bounded display prefix for nonempty content", () => {
    expect(
      toPublicComplianceNotice({
        ...validNotice,
        message: `${" ".repeat(PUBLIC_COMPLIANCE_NOTICE_LIMITS.message)}hidden`,
      })
    ).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https://user:password@example.com/docs",
    "https://example.com/docs\nunsafe",
    `https://example.com/${"x".repeat(
      PUBLIC_COMPLIANCE_NOTICE_LIMITS.referenceUrl
    )}`,
  ])(
    "omits unsafe reference URL %s without dropping the notice",
    (reference_url) => {
      expect(
        toPublicComplianceNotice({ ...validNotice, reference_url })
      ).toEqual(validNotice);
    }
  );

  it("caps both raw scanning and projected output while preserving order", () => {
    const invalid = Array.from({ length: 50 }, () => ({
      message: "missing identifiers",
    }));
    const valid = Array.from({ length: 75 }, (_, index) => ({
      ...validNotice,
      code: `notice_${index}`,
    }));

    const projected = projectPublicComplianceNotices([...invalid, ...valid]);
    expect(projected).toHaveLength(PUBLIC_COMPLIANCE_NOTICE_LIMITS.maxNotices);
    expect(projected[0].code).toBe("notice_0");
    expect(projected.at(-1)?.code).toBe("notice_49");

    const beyondScan = projectPublicComplianceNotices([
      ...Array.from(
        { length: PUBLIC_COMPLIANCE_NOTICE_LIMITS.maxScan },
        () => null
      ),
      validNotice,
    ]);
    expect(beyondScan).toEqual([]);
  });
});
