import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reconcileAddieMatchedV4ProviderBilling,
  type AddieMatchedV4BillingReconciliationTarget,
  type AddieMatchedV4ProviderBillingExport,
} from "../../../src/addie/eval/matched-v4-provider-billing-reconciliation.js";

const dispatches = [
  {
    provider: "anthropic" as const,
    providerResponseId: "msg_1",
    dispatchedAt: "2026-09-10T00:20:00.000Z",
  },
  {
    provider: "openai" as const,
    providerResponseId: "resp_2",
    dispatchedAt: "2026-09-10T00:40:00.000Z",
  },
];
const sealedTarget = {
  dispatches,
  accountScopeByProvider: {
    anthropic: "anthropic-dedicated-project",
    openai: "openai-dedicated-project",
  },
  runStartedAt: "2026-09-10T00:15:00.000Z",
  runEndedAt: "2026-09-10T00:45:00.000Z",
} satisfies AddieMatchedV4BillingReconciliationTarget;
const exported = (
  provider: "anthropic" | "openai" | "google",
  lines: readonly { providerResponseId: string; billedCostMicros: number }[],
): AddieMatchedV4ProviderBillingExport => ({
  kind: "addie_matched_v4_provider_billing_export",
  version: 1,
  provider,
  exportId: `${provider}-export-1`,
  accountScopeId: `${provider}-dedicated-project`,
  coverageStartedAt: "2026-09-10T00:00:00.000Z",
  coverageEndedAt: "2026-09-10T01:00:00.000Z",
  currency: "USD",
  sourceSha256: "a".repeat(64),
  lines,
});
const attestationWorkflow = () =>
  readFileSync(
    new URL(
      "../../../../.github/workflows/verify-matched-v4-runtime-attestation.yml",
      import.meta.url,
    ),
    "utf8",
  );

describe("matched-v4 provider-authoritative billing reconciliation", () => {
  it("keeps even complete caller-constructed projections pending", () => {
    expect(
      reconcileAddieMatchedV4ProviderBilling(dispatches, [
        exported("anthropic", [
          { providerResponseId: "msg_1", billedCostMicros: 31 },
        ]),
        exported("openai", [
          { providerResponseId: "resp_2", billedCostMicros: 47 },
        ]),
      ]),
    ).toEqual({
      status: "cost_settlement_pending",
      reason: "untrusted_billing_export",
    });
  });

  it("fails closed instead of dereferencing malformed dispatch and export entries", () => {
    const reconcileMalformed = () =>
      reconcileAddieMatchedV4ProviderBilling(
        [null as never, ...dispatches],
        [
          null as never,
          exported("anthropic", [null as never]),
          exported("openai", [
            { providerResponseId: "resp_2", billedCostMicros: 47 },
          ]),
        ],
      );
    expect(reconcileMalformed).not.toThrow();
    expect(reconcileMalformed()).toEqual({
      status: "cost_settlement_pending",
      reason: "untrusted_billing_export",
    });
  });

  it("requires the eventual sealed adapter target to carry dispatch timestamps", () => {
    expect(sealedTarget.dispatches).toEqual([
      expect.objectContaining({ dispatchedAt: "2026-09-10T00:20:00.000Z" }),
      expect.objectContaining({ dispatchedAt: "2026-09-10T00:40:00.000Z" }),
    ]);
    expect(sealedTarget.runStartedAt).toBe("2026-09-10T00:15:00.000Z");
    expect(sealedTarget.runEndedAt).toBe("2026-09-10T00:45:00.000Z");
  });

  it("cannot settle a projection with an out-of-window dispatch timestamp", () => {
    expect(
      reconcileAddieMatchedV4ProviderBilling(
        [
          dispatches[0]!,
          { ...dispatches[1]!, dispatchedAt: "2026-09-10T02:00:00.000Z" },
        ],
        [
          exported("anthropic", [
            { providerResponseId: "msg_1", billedCostMicros: 31 },
          ]),
          exported("openai", [
            { providerResponseId: "resp_2", billedCostMicros: 47 },
          ]),
        ],
      ),
    ).toEqual({
      status: "cost_settlement_pending",
      reason: "untrusted_billing_export",
    });
  });

  it("accepts only the exact deployment-environment UTF8String in DER", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "matched-v4-oid-"));
    const parserPath = join(temporaryDirectory, "verify-environment.py");
    const workflow = attestationWorkflow();
    const heredocStart = workflow.indexOf(
      "          python3 - <<'PY'\n",
      workflow.indexOf("export CERTIFICATE_DER"),
    );
    const heredocEnd = workflow.indexOf("\n          PY", heredocStart);
    expect(heredocStart).toBeGreaterThan(-1);
    expect(heredocEnd).toBeGreaterThan(heredocStart);
    writeFileSync(
      parserPath,
      workflow
        .slice(heredocStart + "          python3 - <<'PY'\n".length, heredocEnd)
        .replace(/^ {10}/gm, ""),
    );
    const certificate = (name: string, environment: string) => {
      const keyPath = join(temporaryDirectory, `${name}.key`);
      const pemPath = join(temporaryDirectory, `${name}.pem`);
      const derPath = join(temporaryDirectory, `${name}.der`);
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          pemPath,
          "-nodes",
          "-subj",
          "/CN=matched-v4-test",
          "-days",
          "1",
          "-addext",
          `1.3.6.1.4.1.57264.1.23=ASN1:UTF8String:${environment}`,
        ],
        { stdio: "ignore" },
      );
      execFileSync("openssl", [
        "x509",
        "-in",
        pemPath,
        "-outform",
        "DER",
        "-out",
        derPath,
      ]);
      return derPath;
    };
    const run = (certificatePath: string) =>
      execFileSync("python3", [parserPath], {
        env: {
          ...process.env,
          CERTIFICATE_DER: certificatePath,
          EXPECTED_DEPLOYMENT_ENVIRONMENT: "matched-v4-runtime-attestation",
        },
        stdio: "pipe",
      });
    try {
      expect(() =>
        run(certificate("valid", "matched-v4-runtime-attestation")),
      ).not.toThrow();
      expect(() => run(certificate("wrong", "other-environment"))).toThrow();
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("isolates OIDC from untrusted build code and signs only its checked digest", () => {
    const workflow = attestationWorkflow();
    const untrustedBuild = workflow.slice(
      workflow.indexOf("  verify-origin-main:"),
      workflow.indexOf("  attest-runtime-bundle:"),
    );
    const protectedAttestation = workflow.slice(
      workflow.indexOf("  attest-runtime-bundle:"),
    );
    const verification = workflow.indexOf("cosign verify-blob");
    const retainedBundle = workflow.lastIndexOf("actions/upload-artifact@");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(workflow).toContain("environment: matched-v4-runtime-attestation");
    expect(workflow).toContain('test "$DISPATCH_SHA" = "$current_main_sha"');
    expect(workflow).toContain(
      "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
    );
    expect(untrustedBuild).not.toContain("id-token: write");
    expect(untrustedBuild).toContain("npm ci");
    expect(untrustedBuild).toContain("npm run build");
    expect(protectedAttestation).toContain("id-token: write");
    expect(protectedAttestation).not.toContain("actions/checkout@");
    expect(protectedAttestation).not.toContain("npm ci");
    expect(protectedAttestation).not.toContain("npm run build");
    expect(protectedAttestation).toContain(
      "matched-v4-runtime-attestation.json",
    );
    expect(protectedAttestation).toContain("bundle_sha256");
    expect(protectedAttestation).toContain("gh api");
    expect(protectedAttestation).toContain("GH_TOKEN: ${{ github.token }}");
    expect(protectedAttestation).toContain("1.3.6.1.4.1.57264.1.23");
    expect(protectedAttestation.match(/--new-bundle-format/g)).toHaveLength(2);
    expect(protectedAttestation).toContain(
      ".verificationMaterial.certificate.rawBytes",
    );
    expect(protectedAttestation).toContain("deployment-environment OID");
    expect(protectedAttestation).toContain("not an OCTET STRING");
    expect(protectedAttestation).toContain("not one UTF8String");
    expect(protectedAttestation).toContain(
      "matched-v4-runtime.certificate.der",
    );
    expect(protectedAttestation).toContain("retention-days: 90");
    expect(protectedAttestation).toContain(
      'test "$APPROVED_MAIN_SHA" = "$current_main_sha"',
    );
    expect(verification).toBeGreaterThan(-1);
    expect(retainedBundle).toBeGreaterThan(verification);
    expect(workflow).not.toContain("${{ secrets.");
    expect(workflow).not.toContain("eval:addie-matched-v4-authorized");
  });

  it("marks every authorized runtime report pending external billing reconciliation", () => {
    const runner = readFileSync(
      new URL(
        "../../../src/addie/eval/matched-v4-authorized-execution.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(runner).toContain('costSettlement: "cost_settlement_pending"');
    expect(runner).toContain("estimatedCostUsd");
  });
});
