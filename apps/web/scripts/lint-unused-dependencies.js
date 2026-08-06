import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const ignoredDirectories = new Set(["dist", "ladle-build", "node_modules"]);
const ignoredFiles = new Set(["lint-unused-dependencies.js", "package-lock.json", "package.json"]);

async function collectProjectText(directory) {
  const chunks = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && ignoredFiles.has(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(...(await collectProjectText(entryPath)));
    } else if (entry.isFile()) {
      chunks.push(await readFile(entryPath, "utf8"));
    }
  }

  return chunks;
}

function packageCommandIsUsed(packageName, scripts) {
  try {
    const packageManifest = JSON.parse(
      readFileSync(path.join(projectRoot, "node_modules", packageName, "package.json"), "utf8"),
    );
    const bins =
      typeof packageManifest.bin === "string"
        ? [packageName.split("/").at(-1)]
        : Object.keys(packageManifest.bin ?? {});
    return bins.some((bin) =>
      Object.values(scripts).some((script) =>
        new RegExp(
          `(?:^|[\\s&|;])${bin.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:[\\s&|;]|$)`,
        ).test(script),
      ),
    );
  } catch {
    return false;
  }
}

const projectText = (await collectProjectText(projectRoot)).join("\n");
const declaredDependencies = {
  ...manifest.dependencies,
  ...manifest.devDependencies,
};
const unused = Object.keys(declaredDependencies).filter((packageName) => {
  const runtimePackage = packageName.startsWith("@types/")
    ? packageName.slice("@types/".length).replace("__", "/")
    : packageName;
  return (
    !projectText.includes(packageName) &&
    !projectText.includes(runtimePackage) &&
    !packageCommandIsUsed(packageName, manifest.scripts)
  );
});

if (unused.length > 0) {
  console.error("Unused dependencies in package.json:");
  for (const packageName of unused) console.error(`  - ${packageName}`);
  process.exitCode = 1;
} else {
  console.log("No unused dependencies in package.json.");
}
