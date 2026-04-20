/**
 * One-shot backfill: sign every committed AI-generated PNG under images/**
 * and docs/images/** with an AAO C2PA manifest.
 *
 * Usage:
 *   export C2PA_SIGNING_ENABLED=true
 *   export C2PA_CERT_PEM_B64="$(base64 < ~/aao-c2pa-signing/aao-c2pa.cert.pem)"
 *   export C2PA_PRIVATE_KEY_PEM_B64="$(base64 < ~/aao-c2pa-signing/aao-c2pa.key.pem)"
 *   npx tsx scripts/backfill-c2pa-static.ts [--dry-run]
 *
 * Skips any file that already has a C2PA manifest embedded. Rewrites files
 * in place; the resulting `git diff` is a single large binary commit that
 * lands every existing storyboard as signed.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { Reader } from "@contentauth/c2pa-node";
import { fileTypeFromBuffer } from "file-type";
import { signC2PA, isC2PASigningEnabled } from "../server/src/services/c2pa.js";

const ROOTS = ["images", "docs/images"];
const SIGNABLE_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

interface BackfillStats {
  signed: number;
  skippedAlreadySigned: number;
  failed: number;
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (!fs.existsSync(dir)) return;
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      out.push(full);
    }
  }
}

async function hasEmbeddedManifest(buffer: Buffer, mimeType: string): Promise<boolean> {
  try {
    const reader = await Reader.fromAsset({ buffer, mimeType });
    return reader.isEmbedded();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (!isC2PASigningEnabled()) {
    console.error(
      "C2PA_SIGNING_ENABLED + C2PA_CERT_PEM_B64 + C2PA_PRIVATE_KEY_PEM_B64 must all be set.",
    );
    process.exit(1);
  }

  const files: string[] = [];
  for (const root of ROOTS) await walk(root, files);
  files.sort();

  console.log(`Found ${files.length} PNGs under ${ROOTS.join(", ")}.`);
  if (dryRun) console.log("(dry run — no files will be modified)");

  const stats: BackfillStats = { signed: 0, skippedAlreadySigned: 0, failed: 0 };

  for (const file of files) {
    const buffer = await fs.promises.readFile(file);

    // Detect actual MIME type from magic bytes — some committed .png files
    // are really JPEGs with the wrong extension. c2pa-rs rejects a MIME/buffer
    // mismatch, so we feed it the truth.
    const detected = await fileTypeFromBuffer(buffer);
    const mimeType = detected?.mime ?? "image/png";
    if (!SIGNABLE_MIME_TYPES.has(mimeType)) {
      console.warn(`  ⚠ ${file}: unsupported type ${mimeType}, skipping`);
      continue;
    }

    if (await hasEmbeddedManifest(buffer, mimeType)) {
      stats.skippedAlreadySigned++;
      continue;
    }
    try {
      const signed = signC2PA(buffer, {
        claimGenerator: "AAO Docs Storyboard Generator",
        title: path.basename(file),
        softwareAgent: { name: "gemini-3.1-flash-image-preview", version: "preview" },
        mimeType,
        attributes: {
          relative_path: path.relative(process.cwd(), file),
          // Backfilled rows hash the file bytes since the original prompt is
          // no longer available. The hash still serves as tamper evidence.
          source_sha256: createHash("sha256").update(buffer).digest("hex"),
          backfilled: true,
        },
      });
      if (!dryRun) await fs.promises.writeFile(file, signed.signedBuffer);
      stats.signed++;
      if (stats.signed % 10 === 0 || stats.signed === files.length) {
        console.log(`  [${stats.signed}/${files.length}] ${file}`);
      }
    } catch (err) {
      console.error(`  ✗ ${file}: ${(err as Error).message}`);
      stats.failed++;
    }
  }

  console.log(
    `\n✅ Signed ${stats.signed}, skipped ${stats.skippedAlreadySigned} already-signed, ${stats.failed} failed.`,
  );
  if (stats.failed > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
