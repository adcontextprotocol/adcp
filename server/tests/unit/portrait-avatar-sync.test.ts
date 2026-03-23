import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const portraitDbPath = resolve(__dirname, "../../src/db/portrait-db.ts");
const portraitDbSource = readFileSync(portraitDbPath, "utf-8");

/**
 * Portrait-Avatar Sync Tests
 *
 * When a portrait is approved, the user's community avatar_url should be set
 * to the portrait serving URL. When a portrait is removed, avatar_url should
 * be cleared (only if it pointed to a portrait).
 *
 * These tests validate the SQL in portrait-db.ts to ensure the sync logic
 * is correct without requiring a live database.
 */

describe("approvePortrait", () => {
  it("sets avatar_url on users table via org membership join", () => {
    // The approve function should update users.avatar_url
    expect(portraitDbSource).toContain("UPDATE users SET avatar_url");
    // It should join through member_profiles -> organization_memberships -> users
    expect(portraitDbSource).toContain("organization_memberships");
    expect(portraitDbSource).toContain("member_profiles mp");
  });

  it("constructs portrait URL from portrait ID", () => {
    // The URL pattern should be /api/portraits/{id}.png
    expect(portraitDbSource).toContain("/api/portraits/${portraitId}.png");
  });

  it("runs within the same transaction as the portrait approval", () => {
    // The approve function should use BEGIN/COMMIT
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("BEGIN");
    expect(approveSection).toContain("COMMIT");
    expect(approveSection).toContain("ROLLBACK");
    // The avatar_url update should be inside the transaction
    expect(approveSection).toContain("UPDATE users SET avatar_url");
  });

  it("aborts if the portrait does not belong to the profile", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("rowCount");
    expect(approveSection).toContain("return null");
  });

  it("does not overwrite external avatars", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("avatar_url LIKE '/api/portraits/%'");
  });
});

describe("getPortraitData", () => {
  it("only serves approved portraits", () => {
    expect(portraitDbSource).toContain("WHERE id = $1 AND status = 'approved'");
  });
});

describe("removeFromProfile", () => {
  it("clears avatar_url only when it points to a portrait", () => {
    const removeSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function removeFromProfile"),
      portraitDbSource.indexOf("/** Soft-delete")
    );
    // Should clear avatar_url
    expect(removeSection).toContain("UPDATE users SET avatar_url = NULL");
    // Should only clear portrait-based avatars, not external URLs
    expect(removeSection).toContain("avatar_url LIKE '/api/portraits/%'");
  });

  it("runs within a transaction", () => {
    const removeSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function removeFromProfile"),
      portraitDbSource.indexOf("/** Soft-delete")
    );
    expect(removeSection).toContain("BEGIN");
    expect(removeSection).toContain("COMMIT");
    expect(removeSection).toContain("ROLLBACK");
  });
});

describe("community profile API", () => {
  const communityRoutesPath = resolve(__dirname, "../../src/routes/community.ts");
  const communitySource = readFileSync(communityRoutesPath, "utf-8");

  it("does not allow avatar_url in profile update allowedFields", () => {
    const updateSection = communitySource.slice(
      communitySource.indexOf("const allowedFields"),
      communitySource.indexOf("const updates")
    );
    expect(updateSection).not.toContain("avatar_url");
  });
});

describe("backfill migration", () => {
  const migrationPath = resolve(__dirname, "../../src/db/migrations/324_backfill_portrait_avatars.sql");
  const migration = readFileSync(migrationPath, "utf-8");

  it("only backfills users without an existing avatar", () => {
    expect(migration).toContain("avatar_url IS NULL");
  });

  it("joins through org memberships to find the right users", () => {
    expect(migration).toContain("organization_memberships");
    expect(migration).toContain("member_profiles");
    expect(migration).toContain("member_portraits");
  });

  it("only uses approved portraits", () => {
    expect(migration).toContain("status = 'approved'");
  });
});
