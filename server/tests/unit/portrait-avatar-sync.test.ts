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
 * Portraits belong to users (not member profiles). When a portrait is approved,
 * the user's avatar_url and portrait_id should be set. When removed, both should
 * be cleared (only if avatar pointed to a portrait).
 *
 * These tests validate the SQL in portrait-db.ts to ensure the sync logic
 * is correct without requiring a live database.
 */

describe("approvePortrait", () => {
  it("sets avatar_url and portrait_id on users table", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("UPDATE users SET portrait_id");
    expect(approveSection).toContain("avatar_url");
  });

  it("syncs portrait_id to member_profiles for directory display", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("UPDATE member_profiles");
    expect(approveSection).toContain("organization_memberships");
  });

  it("constructs portrait URL from portrait ID", () => {
    expect(portraitDbSource).toContain("/api/portraits/${portraitId}.png");
  });

  it("runs within the same transaction as the portrait approval", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("BEGIN");
    expect(approveSection).toContain("COMMIT");
    expect(approveSection).toContain("ROLLBACK");
    expect(approveSection).toContain("UPDATE users SET portrait_id");
  });

  it("aborts if the portrait does not belong to the user", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("rowCount");
    expect(approveSection).toContain("return null");
  });

  it("uses user_id to match portrait ownership", () => {
    const approveSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function approvePortrait"),
      portraitDbSource.indexOf("return getPortraitById(portraitId)")
    );
    expect(approveSection).toContain("user_id");
  });
});

describe("getPortraitData", () => {
  it("serves approved and generated portraits for preview", () => {
    expect(portraitDbSource).toContain("status IN ('approved', 'generated')");
  });
});

describe("removeFromUser", () => {
  it("clears avatar_url only when it points to a portrait", () => {
    const removeSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function removeFromUser"),
      portraitDbSource.indexOf("/** Soft-delete")
    );
    expect(removeSection).toContain("UPDATE users SET portrait_id = NULL, avatar_url = NULL");
    expect(removeSection).toContain("avatar_url LIKE '/api/portraits/%'");
  });

  it("also clears member_profiles portrait_id for directory sync", () => {
    const removeSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function removeFromUser"),
      portraitDbSource.indexOf("/** Soft-delete")
    );
    expect(removeSection).toContain("UPDATE member_profiles");
    expect(removeSection).toContain("portrait_id = NULL");
  });

  it("runs within a transaction", () => {
    const removeSection = portraitDbSource.slice(
      portraitDbSource.indexOf("async function removeFromUser"),
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

describe("user_id migration", () => {
  const migrationPath = resolve(__dirname, "../../src/db/migrations/329_portraits_user_id.sql");
  const migration = readFileSync(migrationPath, "utf-8");

  it("adds user_id column to member_portraits", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS user_id TEXT");
  });

  it("adds portrait_id column to users table", () => {
    expect(migration).toContain("ALTER TABLE users ADD COLUMN IF NOT EXISTS portrait_id UUID");
  });

  it("backfills user_id from existing org membership data", () => {
    expect(migration).toContain("UPDATE member_portraits");
    expect(migration).toContain("organization_memberships");
  });

  it("makes member_profile_id nullable", () => {
    expect(migration).toContain("ALTER COLUMN member_profile_id DROP NOT NULL");
  });

  it("creates index on user_id", () => {
    expect(migration).toContain("idx_member_portraits_user_id");
  });
});
