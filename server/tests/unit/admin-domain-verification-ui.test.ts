import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin account domain verification recovery UI", () => {
  const source = readFileSync(
    join(process.cwd(), "server/public/admin-account-detail.html"),
    "utf8"
  );
  const httpSource = readFileSync(
    join(process.cwd(), "server/src/http.ts"),
    "utf8"
  );

  it("uses the WorkOS re-check endpoint for pending domains", () => {
    expect(source).toContain('data-action="verify">Force Re-check</button>');
    expect(source).toContain(
      "/domains/${encodeURIComponent(domain.toLowerCase())}/verify"
    );
  });

  it("requires a second-step attested override when WorkOS remains pending", () => {
    expect(source).toContain("data.error === 'still_pending'");
    expect(source).toContain("data.workos_domain_id");
    expect(source).toContain("verification_attestation: attestation.trim()");
    expect(source).toContain("/override-verification");
    expect(source).toContain("} finally {");
  });

  it("keeps immutable domain override attestations behind the global-admin gate", () => {
    expect(httpSource).toContain(
      "this.app.get('/api/admin/audit-logs', ...requireGlobalAdmin"
    );
  });
});
