import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_ROOT = process.env.DOCS_SMOKE_APP_ROOT || '/app';
const DOCS_CONFIG_PATH = path.join(APP_ROOT, 'docs.json');
const DOCS_INDEXER_PATH = pathToFileURL(
  path.join(APP_ROOT, 'dist/addie/mcp/docs-indexer.js'),
).href;

function collectStrings(value, results = []) {
  if (typeof value === 'string') {
    results.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, results);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, results);
  }
  return results;
}

function collectNavigationPages(value, results = []) {
  if (typeof value === 'string') {
    results.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNavigationPages(item, results);
  } else if (value && typeof value === 'object' && Array.isArray(value.pages)) {
    collectNavigationPages(value.pages, results);
  }
  return results;
}

function findJsonFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(entryPath);
    }
  }
  return files;
}

function findIndexedSchema(getDocById, expected) {
  for (const schemaFile of findJsonFiles(expected.schemasDirectory)) {
    const schemaPath = path.relative(expected.schemasDirectory, schemaFile)
      .replaceAll(path.sep, '/')
      .replace(/\.json$/, '');
    const indexedSchema = getDocById(
      `schema:${expected.version}:${schemaPath}`,
      { version: expected.version },
    );
    if (indexedSchema) return indexedSchema;
  }
  return null;
}

assert.ok(fs.existsSync(DOCS_CONFIG_PATH), 'The runtime image must contain /app/docs.json');

const config = JSON.parse(fs.readFileSync(DOCS_CONFIG_PATH, 'utf8'));
const configuredVersions = config.navigation?.versions;
assert.ok(
  Array.isArray(configuredVersions) && configuredVersions.length > 0,
  'docs.json must configure navigation versions',
);

const expectedVersions = configuredVersions.map((entry) => {
  const searchRoutes = collectStrings(entry.groups).filter((value) => value.startsWith('dist/docs/'));
  const artifacts = new Set(
    searchRoutes.map((page) => page.match(/^dist\/docs\/([^/]+)\//)?.[1]).filter(Boolean),
  );
  assert.equal(
    artifacts.size,
    1,
    `Docs version ${entry.version ?? '<unnamed>'} must select exactly one snapshot`,
  );

  const artifactVersion = [...artifacts][0];
  const version = String(entry.version).replace(/\s*\(archived\)\s*$/i, '');
  const pagePaths = collectNavigationPages(entry.groups)
    .filter((value) => value.startsWith(`dist/docs/${artifactVersion}/`))
    .map((page) => page
    .replace(`dist/docs/${artifactVersion}/`, '')
    .replace(/\.(md|mdx)$/, ''));

  const docsDirectory = path.join(APP_ROOT, 'dist/docs', artifactVersion);
  const schemasDirectory = path.join(APP_ROOT, 'dist/schemas', artifactVersion);
  assert.ok(
    fs.existsSync(docsDirectory) && fs.statSync(docsDirectory).isDirectory(),
    `Missing runtime docs snapshot ${artifactVersion}`,
  );

  for (const pagePath of pagePaths) {
    assert.ok(
      fs.existsSync(path.join(docsDirectory, `${pagePath}.mdx`))
        || fs.existsSync(path.join(docsDirectory, `${pagePath}.md`)),
      `Runtime snapshot ${artifactVersion} is missing configured page ${pagePath}`,
    );
  }
  assert.ok(
    fs.existsSync(schemasDirectory) && fs.statSync(schemasDirectory).isDirectory(),
    `Missing runtime schema snapshot ${artifactVersion}`,
  );

  return { version, artifactVersion, pagePaths, schemasDirectory };
});

const {
  getDocById,
  getSupportedDocsVersions,
  initializeDocsIndex,
  isDocsIndexReady,
} = await import(DOCS_INDEXER_PATH);

await initializeDocsIndex();
assert.equal(isDocsIndexReady(), true, 'The compiled docs indexer did not become ready');

const runtimeVersions = getSupportedDocsVersions();
assert.equal(
  runtimeVersions.length,
  expectedVersions.length,
  'The runtime indexer did not load every docs.json version',
);

for (const expected of expectedVersions) {
  const runtimeVersion = runtimeVersions.find((item) => item.version === expected.version);
  assert.ok(runtimeVersion, `The runtime index is missing docs version ${expected.version}`);
  assert.equal(runtimeVersion.artifactVersion, expected.artifactVersion);

  const indexedDoc = expected.pagePaths
    .map((pagePath) => getDocById(`doc:${expected.version}:${pagePath}`, { version: expected.version }))
    .find(Boolean);
  assert.ok(indexedDoc, `Snapshot ${expected.artifactVersion} produced no indexed documentation`);
  assert.equal(indexedDoc.artifactVersion, expected.artifactVersion);

  const indexedSchema = findIndexedSchema(getDocById, expected);
  assert.ok(indexedSchema, `Snapshot ${expected.artifactVersion} produced no indexed schemas`);
  assert.equal(indexedSchema.artifactVersion, expected.artifactVersion);

  console.log(
    `Indexed ${expected.version} from snapshot ${expected.artifactVersion}: `
      + `${indexedDoc.id}, ${indexedSchema.id}`,
  );
}

console.log(`Runtime docs index smoke passed for ${expectedVersions.length} configured versions.`);
