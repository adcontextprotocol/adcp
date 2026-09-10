import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reconcileAddieMatchedV4ProviderBilling,
  validateAddieMatchedV4ProviderBillingSettlementProjection,
  type AddieMatchedV4BillingReconciliationTarget,
  type AddieMatchedV4ProviderBillingSettlementReceipt,
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
  dedicatedScopeByProvider: {
    anthropic: "anthropic-dedicated-workspace-key",
    openai: "openai-dedicated-project",
  },
  runStartedAt: "2026-09-10T00:15:00.000Z",
  runEndedAt: "2026-09-10T00:45:00.000Z",
} satisfies AddieMatchedV4BillingReconciliationTarget;

const receipt = (
  provider: "anthropic" | "openai" | "google",
): AddieMatchedV4ProviderBillingSettlementReceipt => ({
  kind: "addie_matched_v4_provider_billing_settlement_receipt",
  version: 2,
  provider,
  nativeGranularity:
    provider === "openai"
      ? "openai_daily_project_line_item"
      : provider === "anthropic"
        ? "anthropic_time_api_key_workspace_model"
        : "google_cloud_billing_account_project_service_sku_time_resource",
  nativeExportIdentity: `${provider}-native-export-1`,
  authenticatedNativeSourceSha256:
    provider === "anthropic" ? "a".repeat(64) : "b".repeat(64),
  dedicatedScopeId:
    provider === "anthropic"
      ? "anthropic-dedicated-workspace-key"
      : `${provider}-dedicated-project`,
  coverageStartedAt: "2026-09-10T00:00:00.000Z",
  coverageEndedAt: "2026-09-10T01:00:00.000Z",
  settledThroughAt: "2026-09-10T01:00:00.000Z",
  currency: "USD",
  providerReportedAggregateCostMicros: 78,
  scopeIsolation: "exclusive_dedicated_scope",
});
const receipts = () => [receipt("anthropic"), receipt("openai")];
const attestationWorkflow = () =>
  readFileSync(
    new URL(
      "../../../../.github/workflows/verify-matched-v4-runtime-attestation.yml",
      import.meta.url,
    ),
    "utf8",
  );

describe("matched-v4 provider-authoritative aggregate billing", () => {
  it("uses immutable response IDs only as execution-completeness evidence", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(
        sealedTarget,
        receipts(),
      ),
    ).toEqual({ valid: true, issues: [] });
    expect(
      reconcileAddieMatchedV4ProviderBilling(sealedTarget, receipts()),
    ).toEqual({
      status: "cost_settlement_pending",
      reason: "untrusted_billing_receipt",
    });
  });

  it("rejects an empty execution and receipt set", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(
        {
          dispatches: [],
          dedicatedScopeByProvider: {},
          runStartedAt: "2026-09-10T00:15:00.000Z",
          runEndedAt: "2026-09-10T00:45:00.000Z",
        },
        [],
      ),
    ).toEqual({
      valid: false,
      issues: ["execution_completeness_failed"],
    });
  });

  it("requires exactly one complete retained native export receipt per provider", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        receipt("openai"),
        {
          ...receipt("openai"),
          nativeExportIdentity: "openai-native-export-2",
          authenticatedNativeSourceSha256: "c".repeat(64),
        },
      ]).issues,
    ).toContain("duplicate_provider_receipt");
  });

  it("requires the receipt-provider set to equal the execution-provider set", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        receipt("openai"),
        receipt("google"),
      ]).issues,
    ).toContain("unexpected_provider_receipt");
  });

  it("rejects a receipt for the wrong dedicated scope", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        { ...receipt("openai"), dedicatedScopeId: "ordinary-project" },
      ]).issues,
    ).toContain("wrong_dedicated_scope");
  });

  it("rejects incomplete coverage and a stale settlement watermark", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        {
          ...receipt("openai"),
          coverageEndedAt: "2026-09-10T00:30:00.000Z",
          settledThroughAt: "2026-09-10T00:20:00.000Z",
        },
      ]).issues,
    ).toEqual(
      expect.arrayContaining(["coverage_not_complete", "settlement_not_final"]),
    );
  });

  it("rejects extra traffic or a shared dedicated scope", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        { ...receipt("openai"), scopeIsolation: "extra_or_shared_traffic" },
      ]).issues,
    ).toContain("scope_isolation_failed");
  });

  it("rejects duplicate native exports", () => {
    const duplicate = receipt("openai");
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        duplicate,
        { ...duplicate },
      ]).issues,
    ).toContain("duplicate_native_export");
  });

  it("rejects duplicate native source digests despite hex case variation", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        {
          ...receipt("openai"),
          authenticatedNativeSourceSha256: "A".repeat(64),
        },
      ]).issues,
    ).toContain("duplicate_native_export");
  });

  it("rejects non-USD, unsafe totals, and a partial claimed breakdown", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        {
          ...receipt("openai"),
          currency: "EUR",
          providerReportedAggregateCostMicros: Number.MAX_SAFE_INTEGER + 1,
          breakdown: [
            {
              dimension: "model",
              id: "model-only-if-native-export-supplies-it",
              providerReportedCostMicros: 1,
            },
          ],
        },
      ]).issues,
    ).toEqual(
      expect.arrayContaining([
        "unsupported_currency",
        "unsafe_aggregate_total",
      ]),
    );
  });

  it("requires an optional native breakdown to total its aggregate", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        {
          ...receipt("openai"),
          breakdown: [
            {
              dimension: "line_item",
              id: "provider-native-line-item",
              providerReportedCostMicros: 1,
            },
          ],
        },
      ]).issues,
    ).toContain("unsafe_aggregate_total");
  });

  it("accepts only a uniform provider-native breakdown dimension", () => {
    const breakdown = (
      dimension: "model" | "line_item",
      id: string,
      providerReportedCostMicros = 78,
    ) => ({ dimension, id, providerReportedCostMicros });

    const invalidIssues = (provider: "anthropic" | "openai") =>
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        provider === "anthropic" ? receipt("openai") : receipt("anthropic"),
        {
          ...receipt(provider),
          breakdown: [
            breakdown(
              provider === "anthropic" ? "line_item" : "model",
              "wrong",
            ),
          ],
        },
      ]).issues;

    expect(invalidIssues("openai")).toContain("malformed_receipt");
    expect(invalidIssues("anthropic")).toContain("malformed_receipt");
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(sealedTarget, [
        receipt("anthropic"),
        {
          ...receipt("openai"),
          breakdown: [
            breakdown("line_item", "native-line-item-a", 39),
            breakdown("model", "not-a-native-line-item", 39),
          ],
        },
      ]).issues,
    ).toContain("malformed_receipt");

    const googleTarget = {
      ...sealedTarget,
      dispatches: [
        ...dispatches,
        {
          provider: "google" as const,
          providerResponseId: "google-response-3",
          dispatchedAt: "2026-09-10T00:30:00.000Z",
        },
      ],
      dedicatedScopeByProvider: {
        ...sealedTarget.dedicatedScopeByProvider,
        google: "google-dedicated-project",
      },
    } satisfies AddieMatchedV4BillingReconciliationTarget;
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(googleTarget, [
        receipt("anthropic"),
        receipt("openai"),
        {
          ...receipt("google"),
          breakdown: [breakdown("line_item", "sku", 78)],
        },
      ]).issues,
    ).toContain("malformed_receipt");
  });

  it("fails closed without throwing on malformed raw input", () => {
    expect(() =>
      validateAddieMatchedV4ProviderBillingSettlementProjection(
        { dispatches: [null] },
        [
          null,
          {
            get provider() {
              throw new Error("hostile");
            },
          },
        ],
      ),
    ).not.toThrow();
    expect(reconcileAddieMatchedV4ProviderBilling(null, null)).toEqual({
      status: "cost_settlement_pending",
      reason: "untrusted_billing_receipt",
    });
  });

  it("requires complete and unique immutable execution evidence", () => {
    expect(
      validateAddieMatchedV4ProviderBillingSettlementProjection(
        {
          ...sealedTarget,
          dispatches: [dispatches[0], { ...dispatches[0] }],
        },
        receipts(),
      ).issues,
    ).toContain("execution_completeness_failed");
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

  it("has no production receipt capability issuer and leaves runtime reports pending", () => {
    const billingContract = readFileSync(
      new URL(
        "../../../src/addie/eval/matched-v4-provider-billing-reconciliation.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const runner = readFileSync(
      new URL(
        "../../../src/addie/eval/matched-v4-authorized-execution.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(billingContract).not.toContain(
      "createAddieMatchedV4ProviderBilling",
    );
    expect(billingContract).not.toContain('status: "reconciled"');
    expect(runner).toContain('costSettlement: "cost_settlement_pending"');
    expect(runner).toContain("estimatedCostUsd");
  });
});
